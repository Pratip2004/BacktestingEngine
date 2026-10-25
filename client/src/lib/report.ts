// Builds a PDF report from the rendered results, so it has the same structure as the page.
//
// Every outermost [data-report-section] element under the root is captured as an image (html-to-image
// renders through the browser, so Tailwind's oklch colours and Recharts SVGs come out exactly as shown)
// and laid out top to bottom on A4 pages. A section that doesn't fit the rest of a page starts a new one;
// one taller than a page (long tables) is sliced across pages. The heading, settings and page footers
// are real PDF text.

import { toJpeg } from "html-to-image";
import { jsPDF } from "jspdf";

export type T_ReportInfo = {
  title: string; // the strategy, e.g. "Intraday ATM straddle"
  subtitle: string;
  meta: [string, string][]; // settings used, shown under the heading
  fileName: string;
};

const PAGE = { w: 595.28, h: 841.89, margin: 36, gap: 12, footer: 24 };
const PIXEL_RATIO = 2;
const INK = [24, 24, 27] as const;
const MUTED = [113, 113, 122] as const;

// Built-in PDF fonts only cover WinAnsi; swap the few symbols we use that it lacks.
const pdfText = (s: string) => s.replace(/₹/g, "Rs ").replace(/[−–]/g, "-").replace(/→/g, "to").replace(/≈/g, "~");

function outermostSections(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>("[data-report-section]")];
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
}

// Wide tables scroll sideways on screen; a capture would keep only the visible part. Widen the section
// by the hidden overflow while it's captured (it's scaled to the page width anyway), then restore it.
function expandForCapture(el: HTMLElement): () => void {
  let extra = 0;
  for (const node of [el, ...el.querySelectorAll<HTMLElement>("*")]) {
    if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible") {
      extra = Math.max(extra, node.scrollWidth - node.clientWidth);
    }
  }
  if (!extra) return () => {};
  const prev = el.style.width;
  el.style.width = `${el.offsetWidth + extra}px`;
  return () => {
    el.style.width = prev;
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawHeader(pdf: jsPDF, info: T_ReportInfo): number {
  const { margin, w } = PAGE;
  let y = margin + 4;
  pdf.setFont("helvetica", "bold").setFontSize(18).setTextColor(...INK);
  pdf.text(pdfText(info.title), margin, y + 14);
  y += 24;
  pdf.setFont("helvetica", "normal").setFontSize(10).setTextColor(...MUTED);
  pdf.text(pdfText(info.subtitle), margin, y + 10);
  y += 22;

  // Settings in two columns of label / value; a row grows to fit its longest wrapped value.
  const colW = (w - margin * 2) / 2;
  const labelW = 96;
  const lineH = 11;
  pdf.setFontSize(9);
  for (let i = 0; i < info.meta.length; i += 2) {
    const pair = info.meta.slice(i, i + 2).map(([label, value]) => ({
      label: pdfText(label),
      lines: pdf.splitTextToSize(pdfText(value), colW - labelW - 12) as string[],
    }));
    pair.forEach(({ label, lines }, j) => {
      const x = margin + j * colW;
      pdf.setTextColor(...MUTED).text(label, x, y + 9);
      pdf.setTextColor(...INK).text(lines, x + labelW, y + 9);
    });
    y += Math.max(...pair.map((p) => p.lines.length)) * lineH + 4;
  }
  y += 6;
  pdf.setDrawColor(228, 228, 231).line(margin, y, w - margin, y);
  return y + PAGE.gap;
}

function drawFooters(pdf: jsPDF, info: T_ReportInfo) {
  const n = pdf.getNumberOfPages();
  const stamp = new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  for (let i = 1; i <= n; i++) {
    pdf.setPage(i);
    pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(...MUTED);
    pdf.text(pdfText(`${info.title} · generated ${stamp}`), PAGE.margin, PAGE.h - PAGE.margin / 2);
    pdf.text(`Page ${i} of ${n}`, PAGE.w - PAGE.margin, PAGE.h - PAGE.margin / 2, { align: "right" });
  }
}

export async function exportReport(root: HTMLElement, info: T_ReportInfo) {
  const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const contentW = PAGE.w - PAGE.margin * 2;
  const pageBottom = PAGE.h - PAGE.margin - PAGE.footer;
  const pageTop = PAGE.margin;
  let y = drawHeader(pdf, info);

  for (const el of outermostSections(root)) {
    const restore = expandForCapture(el);
    let dataUrl: string;
    try {
      dataUrl = await toJpeg(el, { pixelRatio: PIXEL_RATIO, quality: 0.92, backgroundColor: "#fafafa", cacheBust: true });
    } finally {
      restore();
    }
    const img = await loadImage(dataUrl);
    const scale = contentW / img.naturalWidth; // pt per image pixel
    const h = img.naturalHeight * scale;

    if (h <= pageBottom - y) {
      pdf.addImage(dataUrl, "JPEG", PAGE.margin, y, contentW, h);
      y += h + PAGE.gap;
      continue;
    }
    if (h <= pageBottom - pageTop) {
      pdf.addPage();
      pdf.addImage(dataUrl, "JPEG", PAGE.margin, pageTop, contentW, h);
      y = pageTop + h + PAGE.gap;
      continue;
    }

    // Taller than a page: slice it, filling the rest of this page first if a useful amount is left.
    if (pageBottom - y < 120) {
      pdf.addPage();
      y = pageTop;
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    let srcY = 0;
    while (srcY < img.naturalHeight) {
      const slicePx = Math.min(Math.floor((pageBottom - y) / scale), img.naturalHeight - srcY);
      canvas.width = img.naturalWidth;
      canvas.height = slicePx;
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, srcY, img.naturalWidth, slicePx, 0, 0, img.naturalWidth, slicePx);
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", PAGE.margin, y, contentW, slicePx * scale);
      srcY += slicePx;
      y += slicePx * scale + PAGE.gap;
      if (srcY < img.naturalHeight) {
        pdf.addPage();
        y = pageTop;
      }
    }
  }

  drawFooters(pdf, info);
  pdf.save(info.fileName);
}
