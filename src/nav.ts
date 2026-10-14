import { Home, Network, Store, Wallet, Settings, BadgeDollarSign, Gamepad2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type PageKey = "home" | "subscribe" | "market" | "wallet" | "agent" | "town" | "settings";

export type NavItem = {
  key: PageKey;
  label: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: NavItem[] = [
  { key: "home", label: "首頁", icon: Home },
  { key: "subscribe", label: "認購", icon: BadgeDollarSign },
  { key: "market", label: "二級市場", icon: Store },
  { key: "wallet", label: "錢包", icon: Wallet },
  { key: "agent", label: "代理中心", icon: Network },
  { key: "town", label: "RWMT 小鎮", icon: Gamepad2 },
  { key: "settings", label: "設定", icon: Settings },
];
