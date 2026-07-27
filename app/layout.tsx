import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "SYNCWALL · 毫秒级视频同步控制台",
    template: "%s · SYNCWALL",
  },
  description: "2–100 屏动态视频分发、延迟检测与毫秒级同步播放控制台。",
  applicationName: "SYNCWALL",
  openGraph: {
    title: "SYNCWALL · 毫秒级视频同步控制台",
    description: "2–100 屏动态编排、2000ms 校准冻结与 3000ms 绝对时刻播放。",
    type: "website",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "SYNCWALL · 毫秒级视频同步控制台",
    description: "2–100 屏动态编排、2000ms 校准冻结与 3000ms 绝对时刻播放。",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#11110f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
