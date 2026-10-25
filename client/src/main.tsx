import "@ant-design/v5-patch-for-react-19";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp, ConfigProvider } from "antd";
import { StyleProvider } from "@ant-design/cssinjs";
import App from "./App";
import "@fontsource-variable/inter";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StyleProvider layer>
      <ConfigProvider
        theme={{
          token: {
            fontFamily: "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
            colorPrimary: "#4F46E5",
            colorInfo: "#4F46E5",
            colorText: "#0F172A",
            colorTextSecondary: "#64748B",
            colorTextTertiary: "#94A3B8",
            colorBorder: "#E2E8F0",
            colorBorderSecondary: "#F1F5F9",
            colorBgLayout: "#F8FAFC",
            borderRadius: 8,
            borderRadiusLG: 12,
            fontSize: 13,
            controlHeight: 34,
          },
          components: {
            Layout: { siderBg: "#0B1220", headerBg: "#FFFFFF", bodyBg: "#F8FAFC", triggerBg: "#0B1220" },
            Menu: {
              darkItemBg: "#0B1220",
              darkSubMenuItemBg: "#0B1220",
              darkItemColor: "#94A3B8",
              darkItemHoverColor: "#F8FAFC",
              darkItemHoverBg: "#1E293B",
              darkItemSelectedBg: "#4F46E5",
              darkItemSelectedColor: "#FFFFFF",
              darkGroupTitleColor: "#475569",
              itemBorderRadius: 8,
              itemHeight: 36,
              itemMarginInline: 10,
              groupTitleFontSize: 11,
            },
            Table: { headerBg: "#F8FAFC", headerColor: "#475569", rowHoverBg: "#F8FAFC" },
            Tabs: { itemSelectedColor: "#4F46E5", inkBarColor: "#4F46E5", horizontalItemPadding: "14px 2px" },
            Button: { primaryShadow: "0 1px 2px rgba(79, 70, 229, 0.25)", fontWeight: 500 },
            Segmented: { itemSelectedBg: "#FFFFFF", trackBg: "#F1F5F9" },
          },
        }}
      >
        <AntApp>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QueryClientProvider>
        </AntApp>
      </ConfigProvider>
    </StyleProvider>
  </StrictMode>,
);
