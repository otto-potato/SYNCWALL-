import type { Metadata } from "next";
import { ControlledDevice } from "./controlled-device";

export const metadata: Metadata = {
  title: "被控端",
  description: "SYNCWALL 被控播放设备。",
};

export default function Home() {
  return <ControlledDevice />;
}
