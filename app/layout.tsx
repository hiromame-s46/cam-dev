import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "Boardly｜板書を、きれいな1枚に。",
    description: "黒板の写真を自動で見つけて、まっすぐ高画質に補正。画像またはPDFで保存できる学生向けウェブアプリ。",
    openGraph: {
      title: "Boardly｜板書を、きれいな1枚に。",
      description: "写真を選ぶだけ。黒板を見つけて、まっすぐ、見やすく整えます。",
      type: "website",
      locale: "ja_JP",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "Boardly - 板書を、きれいな1枚に。" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Boardly｜板書を、きれいな1枚に。",
      description: "写真を選ぶだけ。黒板をまっすぐ、見やすく。",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
