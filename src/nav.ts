import { Home, Network, Store, Wallet, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type PageKey = 'home' | 'market' | 'wallet' | 'agent' | 'settings';

export type NavItem = {
  key: PageKey;
  label: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: '首頁', icon: Home },
  { key: 'market', label: '二級市場', icon: Store },
  { key: 'wallet', label: '錢包', icon: Wallet },
  { key: 'agent', label: '代理中心', icon: Network },
  { key: 'settings', label: '設定', icon: Settings },
];
