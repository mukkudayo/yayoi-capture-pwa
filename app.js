/*
 * 撮影アシスト機能（設計図2章）:
 *  - 自動エッジ検出とスクエア切り抜きによるブレ・斜め撮影の防止
 *  - 白飛び・暗所対策としての強制フラッシュ/HDRの自動制御 → CLAHEによる自動補正で近似
 *  - 手やスマホの影を画像処理で自動除去する機能
 *  - ハンズフリー運用フロー: 撮影→送信→自動で次の撮影画面に戻る
 *
 * 画像処理は OpenCV.js（ブラウザ内WASM実行）で完結させ、補正済み画像のみを
 * GAS（Google Apps Script）Web App経由でGoogle Driveへ送信する。PCサーバーへの
 * 直接送信は行わず、スマホ本体にも画像を保持しない（送信後は変数を破棄する）。
 * PC側は起動時にDriveの未取り込みファイルをポーリングして処理する
 * （app/drive_sync/）。
 */

// GAS Web AppのURLと共有シークレットは、コードに直書きせず端末内（localStorage）にのみ
// 保存する。このPWAはGitHub Pages等の公開ホスティングで配信される想定のため、
// ソースコードに秘密情報を含めると誰でも閲覧できてしまう（実際にデプロイ時に検出された
// ため、この方式に変更した経緯がある）。初回起動時に一度だけ入力してもらう。
const GAS_CONFIG_STORAGE_KEY = "yayoiGasConfig";

function loadGasConfig() {
  try {
    const raw = localStorage.getItem(GAS_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.url && parsed.secret) return parsed;
  } catch (err) {
    // 壊れた保存データは無視して再入力を促す
  }
  return null;
}

function promptForGasConfig() {
  const url = window.prompt(
    "初回設定: GAS Web AppのURLを入力してください\n（gas/README.mdのデプロイ手順で取得したURL）"
  );
  if (!url) return null;
  const secret = window.prompt("初回設定: 共有シークレットを入力してください");
  if (!secret) return null;
  const config = { url: url.trim(), secret: secret.trim() };
  localStorage.setItem(GAS_CONFIG_STORAGE_KEY, JSON.stringify(config));
  return config;
}

function getGasConfig() {
  return loadGasConfig() || promptForGasConfig();
}

const video = document.getElementById("video");
const captureCanvas = document.getElementById("capture-canvas");
const previewCanvas = document.getElementById("preview-canvas");
const cameraView = document.getElementById("camera-view");
const previewView = document.getElementById("preview-view");
const statusBar = document.getElementById("status-bar");
const shutterButton = document.getElementById("shutter-button");
const retakeButton = document.getElementById("retake-button");
const sendButton = document.getElementById("send-button");
const processingIndicator = document.getElementById("processing-indicator");
const batchView = document.getElementById("batch-view");
const batchSummary = document.getElementById("batch-summary");
const batchList = document.getElementById("batch-list");
const batchPickerButton = document.getElementById("batch-picker-button");
const batchFileInput = document.getElementById("batch-file-input");
const batchDoneButton = document.getElementById("batch-done-button");

let openCvReady = false;
let processedBlob = null;

function onOpenCvReady() {
  openCvReady = true;
}
// opencv.js のビルドによって初期化完了の通知方法が異なる（onRuntimeInitialized
// コールバックが後から呼ばれる場合と、スクリプト読み込み時点で既に初期化済みの
// 場合がある）ため、両方に対応する。
const openCvCheckInterval = setInterval(() => {
  if (typeof cv === "undefined") return;
  if (cv.Mat) {
    // 既に初期化済み（onRuntimeInitializedは今後呼ばれない可能性があるため直接呼ぶ）
    clearInterval(openCvCheckInterval);
    onOpenCvReady();
  } else if (typeof cv.onRuntimeInitialized !== "undefined") {
    clearInterval(openCvCheckInterval);
    cv.onRuntimeInitialized = onOpenCvReady;
  }
}, 200);

// opencv.js（約10MB）を非同期に読み込む。<script>タグで同期読み込みすると、
// 回線が遅い場合に本体（カメラ起動等）の実行自体がブロックされてしまうため、
// 動的にscript要素を挿入して裏で読み込ませる（openCvReady判定は上のインターバルが行う）。
const opencvScript = document.createElement("script");
opencvScript.src = "opencv.js";
opencvScript.async = true;
opencvScript.onerror = () => {
  setStatus("画像補正エンジンの読み込みに失敗しました。通信環境をご確認のうえページを再読み込みしてください。", "error");
};
document.head.appendChild(opencvScript);

function setStatus(message, level) {
  statusBar.textContent = message;
  statusBar.className = level || "";
}

/** video要素に取得済みのカメラ映像を（再）表示する。iOS Safariはdisplay:noneで
 * 非表示にした<video>の再生を止めてしまうことがあり、単にsrcObjectを設定するだけでは
 * 再表示後に映像が固まったまま（黒画面）になる場合があるため、明示的にplay()を呼ぶ。
 * さらに映像トラック自体が終了してしまっている場合（iOSがバックグラウンド化等で
 * カメラを強制解放した場合）は、カメラを取得し直す。
 */
function resumeVideoPlayback() {
  const stream = video.srcObject;
  const tracks = stream ? stream.getVideoTracks() : [];
  const hasLiveTrack = tracks.some((t) => t.readyState === "live");

  if (!hasLiveTrack) {
    startCamera();
    return;
  }

  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {
      // 自動再生ポリシーで拒否された場合は無視する（ユーザー操作後の再開時は通常発生しない）
    });
  }
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
    setStatus("書類全体が画面に収まるように撮影してください", "");
  } catch (err) {
    setStatus("カメラを起動できませんでした: " + err.message, "error");
  }
}

function showCameraView() {
  cameraView.classList.remove("hidden");
  previewView.classList.add("hidden");
  batchView.classList.add("hidden");
  shutterButton.classList.remove("hidden");
  batchPickerButton.classList.remove("hidden");
  retakeButton.classList.add("hidden");
  sendButton.classList.add("hidden");
  batchDoneButton.classList.add("hidden");
  processedBlob = null;
  resumeVideoPlayback();
}

function showPreviewView() {
  cameraView.classList.add("hidden");
  previewView.classList.remove("hidden");
  batchView.classList.add("hidden");
  shutterButton.classList.add("hidden");
  batchPickerButton.classList.add("hidden");
  retakeButton.classList.remove("hidden");
  sendButton.classList.remove("hidden");
  batchDoneButton.classList.add("hidden");
}

function showBatchView() {
  cameraView.classList.add("hidden");
  previewView.classList.add("hidden");
  batchView.classList.remove("hidden");
  shutterButton.classList.add("hidden");
  batchPickerButton.classList.add("hidden");
  retakeButton.classList.add("hidden");
  sendButton.classList.add("hidden");
  batchDoneButton.classList.remove("hidden");
}

/** 画面に映っている映像を静止画としてキャプチャする。 */
function captureFrame() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  captureCanvas.width = width;
  captureCanvas.height = height;
  const ctx = captureCanvas.getContext("2d");
  ctx.drawImage(video, 0, 0, width, height);
}

/**
 * 過去に撮影・スキャン済みの画像ファイル（写真ライブラリ選択分）を
 * capture-canvas に読み込む。ライブカメラ撮影と同じ補正パイプラインに乗せるための入口。
 */
function loadFileToCaptureCanvas(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      captureCanvas.width = image.naturalWidth;
      captureCanvas.height = image.naturalHeight;
      const ctx = captureCanvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(image.src);
      resolve();
    };
    image.onerror = () => {
      URL.revokeObjectURL(image.src);
      reject(new Error("画像を読み込めませんでした"));
    };
    image.src = URL.createObjectURL(file);
  });
}

/** 4点の輪郭を「左上, 右上, 右下, 左下」の順に並べ替える。 */
function orderQuadPoints(points) {
  const sums = points.map((p) => p.x + p.y);
  const diffs = points.map((p) => p.x - p.y);
  const topLeft = points[sums.indexOf(Math.min(...sums))];
  const bottomRight = points[sums.indexOf(Math.max(...sums))];
  const topRight = points[diffs.indexOf(Math.max(...diffs))];
  const bottomLeft = points[diffs.indexOf(Math.min(...diffs))];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

/**
 * 自動エッジ検出により書類の四隅を推定し、台形補正（射影変換）でトリミングする。
 * 四隅が検出できない場合は元画像をそのまま返す（誤トリミングで情報を失わないため）。
 */
function autoDetectAndCropDocument(srcMat) {
  const gray = new cv.Mat();
  cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  const edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150);
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  cv.dilate(edges, edges, kernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const imageArea = srcMat.rows * srcMat.cols;
  let bestQuad = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < imageArea * 0.2 || area <= bestArea) {
      contour.delete();
      continue;
    }
    const approx = new cv.Mat();
    const peri = cv.arcLength(contour, true);
    cv.approxPolyDP(contour, approx, 0.02 * peri, true);
    if (approx.rows === 4) {
      bestArea = area;
      if (bestQuad) bestQuad.delete();
      bestQuad = approx;
    } else {
      approx.delete();
    }
    contour.delete();
  }

  gray.delete();
  edges.delete();
  kernel.delete();
  contours.delete();
  hierarchy.delete();

  if (!bestQuad) {
    return srcMat.clone();
  }

  const rawPoints = [];
  for (let i = 0; i < 4; i++) {
    rawPoints.push({ x: bestQuad.intPtr(i, 0)[0], y: bestQuad.intPtr(i, 0)[1] });
  }
  bestQuad.delete();
  const [tl, tr, br, bl] = orderQuadPoints(rawPoints);

  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const outputWidth = Math.max(widthTop, widthBottom);
  const outputHeight = Math.max(heightLeft, heightRight);

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight,
  ]);
  const transform = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(
    srcMat, dst, transform, new cv.Size(outputWidth, outputHeight),
    cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar()
  );

  srcTri.delete();
  dstTri.delete();
  transform.delete();
  return dst;
}

/**
 * 白飛び・暗所対策: CLAHE（適応的ヒストグラム均等化）で明るさ・コントラストを自動補正する。
 * ハードウェアのフラッシュ制御はブラウザから行えないため、撮影後の画像補正で近似する。
 */
function enhanceLighting(srcMat) {
  const lab = new cv.Mat();
  cv.cvtColor(srcMat, lab, cv.COLOR_RGBA2RGB);
  cv.cvtColor(lab, lab, cv.COLOR_RGB2Lab);

  const channels = new cv.MatVector();
  cv.split(lab, channels);
  const lChannel = channels.get(0);

  const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
  clahe.apply(lChannel, lChannel);
  clahe.delete();

  channels.set(0, lChannel);
  cv.merge(channels, lab);
  const result = new cv.Mat();
  cv.cvtColor(lab, result, cv.COLOR_Lab2RGB);

  lab.delete();
  channels.delete();
  lChannel.delete();
  return result;
}

/**
 * 手やスマホの影を除去する: 各チャンネルを大きめのカーネルで膨張＋メディアンブラーした
 * 背景推定画像との差分を取り、影による濃淡ムラを平坦化する定番手法。
 */
function removeShadow(srcMat) {
  const channels = new cv.MatVector();
  cv.split(srcMat, channels);
  const resultChannels = new cv.MatVector();
  const kernel = cv.Mat.ones(7, 7, cv.CV_8U);

  for (let i = 0; i < channels.size(); i++) {
    const channel = channels.get(i);
    const dilated = new cv.Mat();
    cv.dilate(channel, dilated, kernel);
    cv.medianBlur(dilated, dilated, 21);

    const diff = new cv.Mat();
    cv.absdiff(channel, dilated, diff);
    const inverted = new cv.Mat();
    cv.bitwise_not(diff, inverted);

    const normalized = new cv.Mat();
    cv.normalize(inverted, normalized, 0, 255, cv.NORM_MINMAX);

    resultChannels.push_back(normalized);
    channel.delete();
    dilated.delete();
    diff.delete();
    inverted.delete();
  }

  const result = new cv.Mat();
  cv.merge(resultChannels, result);

  kernel.delete();
  channels.delete();
  for (let i = 0; i < resultChannels.size(); i++) resultChannels.get(i).delete();
  resultChannels.delete();
  return result;
}

/** キャプチャした画像に3段階の補正（トリミング→明るさ補正→影除去）を適用する。 */
function processImage() {
  const src = cv.imread(captureCanvas);
  const cropped = autoDetectAndCropDocument(src);
  const lit = enhanceLighting(cropped);
  const final = removeShadow(lit);

  cv.imshow(previewCanvas, final);

  src.delete();
  cropped.delete();
  lit.delete();
  final.delete();
}

function canvasToJpegBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
}

shutterButton.addEventListener("click", async () => {
  if (!openCvReady) {
    setStatus("画像補正エンジンを読み込み中です。数秒後にもう一度お試しください。", "warn");
    return;
  }
  if (!video.videoWidth || !video.videoHeight) {
    setStatus("カメラの映像を取得できていません。カメラへのアクセスを許可してください。", "error");
    return;
  }

  captureFrame();
  showPreviewView();
  processingIndicator.classList.remove("hidden");
  try {
    // OpenCV処理はCPU負荷が高いため、プレビュー切り替え直後の描画をブロックしないよう1フレーム待つ。
    await new Promise((r) => requestAnimationFrame(r));
    processImage();
    processedBlob = await canvasToJpegBlob(previewCanvas);
  } catch (err) {
    setStatus("画像の補正に失敗しました: " + err.message, "error");
    showCameraView();
    return;
  } finally {
    processingIndicator.classList.add("hidden");
  }
});

/** Blobをdata URLへ変換し、Base64本体部分のみを取り出す。 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error("画像の変換に失敗しました"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 補正済み画像1枚をGAS Web App経由でGoogle Driveへ送信する。
 * PC側は非同期（起動時ポーリング）で処理するため、この時点では取り込み結果
 * （分類成否・重複判定）は返らない。
 * @returns {{ level: "ok"|"warn"|"error", message: string }}
 */
async function uploadBlob(blob, filename) {
  const config = getGasConfig();
  if (!config) {
    return { level: "error", message: "GAS Web Appの設定が未入力です。ページを再読み込みして設定してください。" };
  }

  try {
    const dataBase64 = await blobToBase64(blob);
    // GAS Web AppはCORSプリフライトに対応できないため、プリフライトを発生させない
    // text/plain指定でPOSTする（本文は引き続きJSON）。認証情報はJSON本体に含める。
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        filename,
        mimeType: "image/jpeg",
        dataBase64,
        sharedSecret: config.secret,
      }),
    });
    const result = await response.json().catch(() => ({}));

    if (response.ok && result.status === "ok") {
      return { level: "ok", message: "アップロード完了（サーバー起動時に自動で取り込まれます）" };
    }
    return { level: "error", message: "送信失敗: " + (result.message || response.statusText) };
  } catch (err) {
    return { level: "error", message: "通信エラー: " + err.message };
  }
}

sendButton.addEventListener("click", async () => {
  if (!processedBlob) return;
  sendButton.disabled = true;
  retakeButton.disabled = true;

  const { level, message } = await uploadBlob(processedBlob, "capture.jpg");
  processedBlob = null; // スマホ本体に画像を残さない
  if (level === "ok") {
    setStatus(`${message}。続けて次の書類を撮影できます。`, "ok");
  } else {
    setStatus(message, level);
  }

  sendButton.disabled = false;
  retakeButton.disabled = false;
  // ハンズフリー運用フロー: 送信後は自動でカメラ画面に戻り、連続撮影できるようにする。
  setTimeout(showCameraView, 1500);
});

retakeButton.addEventListener("click", () => {
  showCameraView();
});

/**
 * 過去に撮影・スキャン済みの画像を複数選択し、1枚ずつ同じ補正パイプラインに通してから
 * 順次アップロードする（紙媒体の過去データをまとめて取り込むための機能）。
 * サーバー負荷・APIレート制限を避けるため並列送信はせず1件ずつ処理する。
 */
async function runBatchImport(files) {
  showBatchView();
  batchSummary.textContent = `0 / ${files.length} 件処理中…`;
  batchList.innerHTML = "";

  const listItems = [];
  for (const file of files) {
    const item = document.createElement("li");

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    nameSpan.textContent = file.name;
    nameSpan.title = file.name;

    const statusSpan = document.createElement("span");
    statusSpan.className = "file-status pending";
    statusSpan.textContent = "待機中";

    item.appendChild(nameSpan);
    item.appendChild(statusSpan);
    batchList.appendChild(item);
    listItems.push(item);
  }

  let okCount = 0;
  let warnCount = 0;
  let errorCount = 0;

  const MAX_STATUS_LENGTH = 40;
  function setItemStatus(statusEl, level, fullMessage) {
    statusEl.className = `file-status ${level}`;
    statusEl.title = fullMessage;
    statusEl.textContent =
      fullMessage.length > MAX_STATUS_LENGTH
        ? fullMessage.slice(0, MAX_STATUS_LENGTH) + "…"
        : fullMessage;
  }

  for (let i = 0; i < files.length; i++) {
    const statusEl = listItems[i].querySelector(".file-status");
    setItemStatus(statusEl, "pending", "処理中…");

    try {
      if (!openCvReady) {
        throw new Error("画像補正エンジンが未初期化です");
      }
      await loadFileToCaptureCanvas(files[i]);
      processImage();
      const blob = await canvasToJpegBlob(previewCanvas);
      const { level, message } = await uploadBlob(blob, files[i].name);
      setItemStatus(statusEl, level, message);
      if (level === "ok") okCount++;
      else if (level === "warn") warnCount++;
      else errorCount++;
    } catch (err) {
      setItemStatus(statusEl, "error", "処理失敗: " + err.message);
      errorCount++;
    }

    batchSummary.textContent =
      `${i + 1} / ${files.length} 件処理済み（成功 ${okCount} / 重複・要確認 ${warnCount} / 失敗 ${errorCount}）`;
  }
}

batchPickerButton.addEventListener("click", () => {
  batchFileInput.click();
});

batchFileInput.addEventListener("change", () => {
  const files = Array.from(batchFileInput.files || []);
  batchFileInput.value = ""; // 同じファイルを連続選択できるようにリセット
  if (files.length === 0) return;
  runBatchImport(files);
});

batchDoneButton.addEventListener("click", () => {
  showCameraView();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

startCamera();
