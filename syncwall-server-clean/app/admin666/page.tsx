import type { Metadata } from "next";
import { SyncWallControl } from "../sync-wall-control";

export const metadata: Metadata = {
  title: "控制端",
  description: "SYNCWALL 多屏同步控制端。",
};

export default function AdminPage() {
  return <SyncWallControl />;
}
