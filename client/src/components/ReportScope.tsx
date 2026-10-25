import { createContext, useContext, useEffect, useRef, useState } from "react";
import { App, Button, Tooltip, Typography } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { exportReport, type T_ReportInfo } from "../lib/report";

const { Text } = Typography;

// True while a PDF is being captured: tables render every row (no pagination) so the report is complete.
const PrintModeContext = createContext(false);
export const usePrintMode = () => useContext(PrintModeContext);

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

// Wraps a backtest's results with a "Download PDF" bar. Mark the parts to include with
// `data-report-section` (SectionCard does this already); the bar itself isn't part of the report.
export default function ReportScope({
  info,
  savedHint,
  autoDownload = false,
  onAutoDownloaded,
  children,
}: {
  info: T_ReportInfo;
  savedHint?: React.ReactNode;
  autoDownload?: boolean; // download once on mount (the Backtests list links here with ?pdf=1)
  onAutoDownloaded?: () => void;
  children: React.ReactNode;
}) {
  const { message } = App.useApp();
  const ref = useRef<HTMLDivElement>(null);
  const [printing, setPrinting] = useState(false);

  const download = async () => {
    setPrinting(true);
    try {
      // Let tables re-render without pagination and charts settle before capturing.
      await nextFrame();
      await nextFrame();
      await new Promise((r) => setTimeout(r, 300));
      await exportReport(ref.current!, info);
    } catch (e) {
      message.error(`Couldn't create the PDF: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPrinting(false);
    }
  };

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoDownload || autoStarted.current) return;
    autoStarted.current = true;
    // Give charts a moment to lay out on first render.
    setTimeout(() => download().finally(() => onAutoDownloaded?.()), 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDownload]);

  return (
    <PrintModeContext.Provider value={printing}>
      <div className="flex items-center justify-between gap-3 flex-wrap bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3 mb-6">
        <Text type="secondary" className="text-xs">{savedHint}</Text>
        <Tooltip title="Report with the same sections as this page, headed by the strategy and its settings">
          <Button icon={<DownloadOutlined />} onClick={download} loading={printing}>
            {printing ? "Creating PDF…" : "Download PDF"}
          </Button>
        </Tooltip>
      </div>
      <div ref={ref} className="space-y-6">
        {children}
      </div>
    </PrintModeContext.Provider>
  );
}
