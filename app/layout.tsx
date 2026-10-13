import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "齒間｜LINE 預約公開展示",
  description: "齒間牙醫預約公開產品展示，不是真實掛號。透過 LINE 體驗示範診所、醫師、排班與管理員確認流程；使用固定示範聯絡資料，每個 LINE 帳號任一連續 24 小時內最多 3 筆。",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
