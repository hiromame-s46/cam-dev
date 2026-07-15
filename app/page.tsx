"use client";

import {
  ChangeEvent,
  DragEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { detectBoardFromImageData } from "./board-detection.mjs";

type Point = { x: number; y: number };
type ViewMode = "crop" | "result";

const DEFAULT_CORNERS: Point[] = [
  { x: 0.06, y: 0.08 },
  { x: 0.94, y: 0.08 },
  { x: 0.94, y: 0.92 },
  { x: 0.06, y: 0.92 },
];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const pointDistance = (a: Point, b: Point, width: number, height: number) =>
  Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);

function detectBoardLegacy(image: HTMLImageElement) {
  const sampleWidth = Math.min(360, image.naturalWidth);
  const sampleHeight = Math.max(
    1,
    Math.round((image.naturalHeight / image.naturalWidth) * sampleWidth),
  );
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { corners: DEFAULT_CORNERS, confident: false };

  context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const mask = new Uint8Array(sampleWidth * sampleHeight);

  for (let i = 0; i < mask.length; i += 1) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const luminance = r * 0.299 + g * 0.587 + b * 0.114;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const boardGreen = g > r * 0.8 && g > b * 0.72;
    const neutralDark = chroma < 48;
    if (luminance > 12 && luminance < 168 && (boardGreen || neutralDark)) {
      mask[i] = 1;
    }
  }

  // Bridge small gaps made by chalk writing and glare.
  const smoothed = new Uint8Array(mask.length);
  for (let y = 1; y < sampleHeight - 1; y += 1) {
    for (let x = 1; x < sampleWidth - 1; x += 1) {
      let neighbours = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          neighbours += mask[(y + oy) * sampleWidth + x + ox];
        }
      }
      if (neighbours >= 4) smoothed[y * sampleWidth + x] = 1;
    }
  }

  const visited = new Uint8Array(mask.length);
  let largest: number[] = [];
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < smoothed.length; start += 1) {
    if (!smoothed[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    const component: number[] = [];
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const index = queue[head++];
      component.push(index);
      const x = index % sampleWidth;
      const y = Math.floor(index / sampleWidth);
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < sampleWidth - 1 ? index + 1 : -1,
        y > 0 ? index - sampleWidth : -1,
        y < sampleHeight - 1 ? index + sampleWidth : -1,
      ];
      for (const next of neighbours) {
        if (next >= 0 && smoothed[next] && !visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    if (component.length > largest.length) largest = component;
  }

  const coverage = largest.length / mask.length;
  if (coverage < 0.075) return { corners: DEFAULT_CORNERS, confident: false };

  let topLeft = { x: sampleWidth, y: sampleHeight };
  let topRight = { x: 0, y: sampleHeight };
  let bottomRight = { x: 0, y: 0 };
  let bottomLeft = { x: sampleWidth, y: 0 };
  let minSum = Infinity;
  let maxSum = -Infinity;
  let maxDiff = -Infinity;
  let minDiff = Infinity;

  for (const index of largest) {
    const x = index % sampleWidth;
    const y = Math.floor(index / sampleWidth);
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) {
      minSum = sum;
      topLeft = { x, y };
    }
    if (diff > maxDiff) {
      maxDiff = diff;
      topRight = { x, y };
    }
    if (sum > maxSum) {
      maxSum = sum;
      bottomRight = { x, y };
    }
    if (diff < minDiff) {
      minDiff = diff;
      bottomLeft = { x, y };
    }
  }

  const corners = [topLeft, topRight, bottomRight, bottomLeft].map((point) => ({
    x: clamp(point.x / sampleWidth, 0.01, 0.99),
    y: clamp(point.y / sampleHeight, 0.01, 0.99),
  }));

  return { corners, confident: coverage > 0.13 };
}

function detectBoard(image: HTMLImageElement) {
  const scale = Math.min(1, 560 / Math.max(image.naturalWidth, image.naturalHeight));
  const sampleWidth = Math.max(12, Math.round(image.naturalWidth * scale));
  const sampleHeight = Math.max(12, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { corners: DEFAULT_CORNERS, confident: false, score: 0 };
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight);
  const detection = detectBoardFromImageData(pixels.data, sampleWidth, sampleHeight);
  if (detection.confident || detection.score >= 0.35) return detection;

  // Keep the former detector as a conservative, editable fallback for unusual
  // photos. It never bypasses the manual confirmation screen.
  const fallback = detectBoardLegacy(image);
  return fallback.confident
    ? { corners: fallback.corners, confident: false, score: detection.score }
    : detection;
}

function warpBoard(image: HTMLImageElement, corners: Point[]) {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const measuredWidth = Math.max(
    pointDistance(corners[0], corners[1], sourceWidth, sourceHeight),
    pointDistance(corners[3], corners[2], sourceWidth, sourceHeight),
  );
  const measuredHeight = Math.max(
    pointDistance(corners[0], corners[3], sourceWidth, sourceHeight),
    pointDistance(corners[1], corners[2], sourceWidth, sourceHeight),
  );
  const outputScale = Math.min(1, 2800 / Math.max(measuredWidth, measuredHeight));
  const width = Math.max(320, Math.round(measuredWidth * outputScale));
  const height = Math.max(220, Math.round(measuredHeight * outputScale));

  const sourceScale = Math.min(1, 4200 / Math.max(sourceWidth, sourceHeight));
  const sampledWidth = Math.max(1, Math.round(sourceWidth * sourceScale));
  const sampledHeight = Math.max(1, Math.round(sourceHeight * sourceScale));
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sampledWidth;
  sourceCanvas.height = sampledHeight;
  const sourceContext = sourceCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputContext = outputCanvas.getContext("2d");
  if (!sourceContext || !outputContext) return outputCanvas;

  sourceContext.drawImage(image, 0, 0, sampledWidth, sampledHeight);
  const source = sourceContext.getImageData(0, 0, sampledWidth, sampledHeight);
  const output = outputContext.createImageData(width, height);
  const sourcePoints = corners.map((corner) => ({
    x: corner.x * (sampledWidth - 1),
    y: corner.y * (sampledHeight - 1),
  }));

  for (let y = 0; y < height; y += 1) {
    const v = height === 1 ? 0 : y / (height - 1);
    const left = {
      x: sourcePoints[0].x * (1 - v) + sourcePoints[3].x * v,
      y: sourcePoints[0].y * (1 - v) + sourcePoints[3].y * v,
    };
    const right = {
      x: sourcePoints[1].x * (1 - v) + sourcePoints[2].x * v,
      y: sourcePoints[1].y * (1 - v) + sourcePoints[2].y * v,
    };

    for (let x = 0; x < width; x += 1) {
      const u = width === 1 ? 0 : x / (width - 1);
      const sx = clamp(left.x * (1 - u) + right.x * u, 0, sampledWidth - 1);
      const sy = clamp(left.y * (1 - u) + right.y * u, 0, sampledHeight - 1);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(sampledWidth - 1, x0 + 1);
      const y1 = Math.min(sampledHeight - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const targetIndex = (y * width + x) * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const p00 = source.data[(y0 * sampledWidth + x0) * 4 + channel];
        const p10 = source.data[(y0 * sampledWidth + x1) * 4 + channel];
        const p01 = source.data[(y1 * sampledWidth + x0) * 4 + channel];
        const p11 = source.data[(y1 * sampledWidth + x1) * 4 + channel];
        const top = p00 * (1 - fx) + p10 * fx;
        const bottom = p01 * (1 - fx) + p11 * fx;
        const value = top * (1 - fy) + bottom * fy;
        output.data[targetIndex + channel] = clamp(
          (value - 118) * 1.1 + 122,
          0,
          255,
        );
      }
      output.data[targetIndex + 3] = 255;
    }
  }

  outputContext.putImageData(output, 0, 0);
  return outputCanvas;
}

function concatBytes(parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function makePdf(jpeg: Uint8Array, imageWidth: number, imageHeight: number) {
  const encoder = new TextEncoder();
  const pageWidth = 842;
  const pageHeight = Math.round(pageWidth * (imageHeight / imageWidth));
  const content = encoder.encode(
    `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`,
  );
  const objects = [
    encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"),
    encoder.encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    encoder.encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    ),
    concatBytes([
      encoder.encode(
        `<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      ),
      jpeg,
      encoder.encode("\nendstream"),
    ]),
    concatBytes([
      encoder.encode(`<< /Length ${content.length} >>\nstream\n`),
      content,
      encoder.encode("endstream"),
    ]),
  ];
  const parts: Uint8Array[] = [encoder.encode("%PDF-1.4\n%Boardly\n")];
  const offsets = [0];
  let byteOffset = parts[0].length;

  objects.forEach((object, index) => {
    offsets.push(byteOffset);
    const wrapped = concatBytes([
      encoder.encode(`${index + 1} 0 obj\n`),
      object,
      encoder.encode("\nendobj\n"),
    ]);
    parts.push(wrapped);
    byteOffset += wrapped.length;
  });

  const xrefOffset = byteOffset;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (let i = 1; i < offsets.length; i += 1) {
    xref.push(`${offsets[i].toString().padStart(10, "0")} 00000 n `);
  }
  xref.push(
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
  );
  parts.push(encoder.encode(`${xref.join("\n")}\n`));
  const documentBytes = concatBytes(parts);
  return new Blob([documentBytes.buffer], { type: "application/pdf" });
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [corners, setCorners] = useState<Point[]>(DEFAULT_CORNERS);
  const [viewMode, setViewMode] = useState<ViewMode>("result");
  const [dragging, setDragging] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("黒板の範囲を自動で見つけました");

  const processImage = useCallback(
    (image = imageRef.current, points = corners) => {
      if (!image) return;
      setProcessing(true);
      window.setTimeout(() => {
        const output = warpBoard(image, points);
        outputCanvasRef.current = output;
        setResultUrl(output.toDataURL("image/png"));
        setProcessing(false);
        setViewMode("result");
        setStatus("補正ができました。保存できます");
      }, 40);
    },
    [corners],
  );

  const loadImage = useCallback((url: string) => {
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      const detection = detectBoard(image);
      setCorners(detection.corners);
      setSourceUrl(url);
      setStatus(
        detection.confident
          ? "黒板の範囲を自動で見つけました"
          : "四隅を動かして、黒板に合わせてください",
      );
      setProcessing(true);
      window.setTimeout(() => {
        const output = warpBoard(image, detection.corners);
        outputCanvasRef.current = output;
        setResultUrl(output.toDataURL("image/png"));
        setProcessing(false);
        setViewMode(detection.confident ? "result" : "crop");
      }, 60);
    };
    image.onerror = () => {
      setProcessing(false);
      setStatus("この画像を開けませんでした。JPGまたはPNGでお試しください");
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }, []);

  const openFile = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("画像ファイルを選んでください");
      return;
    }
    if (sourceUrl?.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
    loadImage(URL.createObjectURL(file));
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    openFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    openFile(event.dataTransfer.files?.[0]);
  };

  const trySample = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#d6ccb9";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#244b40";
    context.beginPath();
    context.moveTo(135, 110);
    context.lineTo(1085, 72);
    context.lineTo(1130, 690);
    context.lineTo(90, 725);
    context.closePath();
    context.fill();
    context.strokeStyle = "#eee8d8";
    context.lineWidth = 10;
    context.stroke();
    context.fillStyle = "rgba(255, 253, 235, 0.92)";
    context.font = "44px sans-serif";
    context.fillText("今日のまとめ", 250, 230);
    context.fillStyle = "#efc96d";
    context.fillRect(250, 250, 345, 7);
    context.fillStyle = "rgba(255, 253, 235, 0.83)";
    context.fillRect(250, 340, 620, 10);
    context.fillRect(250, 430, 480, 10);
    context.fillRect(250, 520, 690, 10);
    context.font = "32px sans-serif";
    context.fillText("授業のポイントをここに整理", 250, 620);
    loadImage(canvas.toDataURL("image/jpeg", 0.94));
  };

  useEffect(() => {
    if (dragging === null) return;
    const move = (event: PointerEvent) => {
      const rect = editorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCorners((current) =>
        current.map((point, index) =>
          index === dragging
            ? {
                x: clamp((event.clientX - rect.left) / rect.width, 0.01, 0.99),
                y: clamp((event.clientY - rect.top) / rect.height, 0.01, 0.99),
              }
            : point,
        ),
      );
    };
    const stop = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [dragging]);

  useEffect(
    () => () => {
      if (sourceUrl?.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
    },
    [sourceUrl],
  );

  const autoDetect = () => {
    if (!imageRef.current) return;
    const detection = detectBoard(imageRef.current);
    setCorners(detection.corners);
    setStatus("黒板の範囲をもう一度見つけました");
    setViewMode("crop");
  };

  const rotate = () => {
    const image = imageRef.current;
    if (!image) return;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalHeight;
    canvas.height = image.naturalWidth;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(image, 0, 0);
    loadImage(canvas.toDataURL("image/jpeg", 0.96));
  };

  const savePng = () => {
    outputCanvasRef.current?.toBlob((blob) => {
      if (blob) downloadBlob(blob, "boardly-note.png");
    }, "image/png");
  };

  const savePdf = () => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    canvas.toBlob(
      async (blob) => {
        if (!blob) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        downloadBlob(makePdf(bytes, canvas.width, canvas.height), "boardly-note.pdf");
      },
      "image/jpeg",
      0.94,
    );
  };

  const reset = () => {
    if (sourceUrl?.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
    imageRef.current = null;
    outputCanvasRef.current = null;
    setSourceUrl(null);
    setResultUrl(null);
    setCorners(DEFAULT_CORNERS);
    setStatus("黒板の範囲を自動で見つけました");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Boardly ホーム">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <span>Boardly</span>
        </a>
        <span className="privacy-pill">
          <span className="privacy-dot" /> 画像は端末内だけで処理
        </span>
      </header>

      {!sourceUrl ? (
        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="eyebrow">FOR STUDENTS</p>
            <h1>
              板書を、
              <br />
              <span>きれいな1枚に。</span>
            </h1>
            <p className="lead">
              写真を選ぶだけ。黒板を見つけて、まっすぐ、見やすく整えます。
            </p>
            <div className="hero-actions">
              <button
                className="primary-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="camera-symbol" aria-hidden="true" />
                写真を撮る・選ぶ
              </button>
              <button className="sample-button" type="button" onClick={trySample}>
                サンプルで試す
              </button>
            </div>
            <p className="microcopy">JPG・PNG・HEICに対応（ブラウザ対応時）</p>
          </div>

          <button
            className="upload-card"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            aria-label="板書の写真を選ぶ"
          >
            <span className="demo-photo" aria-hidden="true">
              <span className="chalk chalk-title">今日のまとめ</span>
              <span className="chalk chalk-line line-one" />
              <span className="chalk chalk-line line-two" />
              <span className="chalk chalk-line line-three" />
              <span className="crop-corner corner-tl" />
              <span className="crop-corner corner-tr" />
              <span className="crop-corner corner-br" />
              <span className="crop-corner corner-bl" />
            </span>
            <span className="upload-hint">ここに写真をドロップしてもOK</span>
          </button>

          <div className="steps" aria-label="使い方">
            <div>
              <span>1</span>
              <p>写真を選ぶ</p>
            </div>
            <i />
            <div>
              <span>2</span>
              <p>自動で補正</p>
            </div>
            <i />
            <div>
              <span>3</span>
              <p>保存する</p>
            </div>
          </div>
        </section>
      ) : (
        <section className="workspace" aria-live="polite">
          <div className="workspace-heading">
            <div>
              <p className="eyebrow">YOUR BOARD</p>
              <h1>板書を整える</h1>
            </div>
            <button className="text-button" type="button" onClick={reset}>
              別の写真を選ぶ
            </button>
          </div>

          <div className="editor-card">
            <div className="view-tabs" role="tablist" aria-label="プレビュー切り替え">
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "crop"}
                onClick={() => setViewMode("crop")}
              >
                1. 範囲を調整
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "result"}
                onClick={() => setViewMode("result")}
              >
                2. 仕上がり
              </button>
            </div>

            <div className={`preview-stage ${processing ? "is-processing" : ""}`}>
              {viewMode === "crop" ? (
                <div className="crop-editor" ref={editorRef}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={sourceUrl} alt="選択した板書写真" />
                  <svg
                    className="crop-polygon"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polygon
                      points={corners
                        .map((point) => `${point.x * 100},${point.y * 100}`)
                        .join(" ")}
                    />
                  </svg>
                  {corners.map((point, index) => (
                    <button
                      className="corner-handle"
                      style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                      type="button"
                      key={index}
                      aria-label={`${index + 1}番目の角を移動`}
                      onPointerDown={(event: ReactPointerEvent) => {
                        event.preventDefault();
                        setDragging(index);
                      }}
                    />
                  ))}
                </div>
              ) : resultUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="result-image" src={resultUrl} alt="補正後の板書" />
              ) : null}
              {processing && (
                <div className="processing-card" role="status">
                  <span className="spinner" />
                  黒板をきれいにしています…
                </div>
              )}
            </div>

            <div className="editor-footer">
              <p className="status-line">
                <span aria-hidden="true">✓</span> {status}
              </p>
              <div className="tool-row">
                <button type="button" onClick={autoDetect}>自動検出</button>
                <button type="button" onClick={rotate}>90°回転</button>
                {viewMode === "crop" && (
                  <button
                    className="apply-button"
                    type="button"
                    onClick={() => processImage()}
                    disabled={processing}
                  >
                    この範囲で補正
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="save-card">
            <div>
              <p className="save-kicker">READY TO SAVE</p>
              <h2>どの形式で保存しますか？</h2>
            </div>
            <div className="save-actions">
              <button type="button" onClick={savePng} disabled={!resultUrl || processing}>
                <span className="file-badge">PNG</span>
                <span><b>画像で保存</b><small>ノートやSNSに</small></span>
              </button>
              <button type="button" onClick={savePdf} disabled={!resultUrl || processing}>
                <span className="file-badge pdf">PDF</span>
                <span><b>PDFで保存</b><small>印刷や提出に</small></span>
              </button>
            </div>
          </div>
        </section>
      )}

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
      />

      <footer>
        <span>Boardly</span>
        <p>授業の「あとで見返す」を、もっと気軽に。</p>
      </footer>
    </main>
  );
}
