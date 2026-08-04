import type { Metadata } from "next";
import { ControlledDevice } from "../controlled-device";

export const metadata: Metadata = {
  title: "被控端",
  description: "SYNCWALL 被控显示设备",
};

export default function ControlledFallbackPage() {
  return <ControlledDevice />;
}
