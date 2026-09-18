import { NavLink, useLocation, useNavigate } from 'react-router';
import { BarChart3, Briefcase, Building2, Check, ChevronsUpDown, CreditCard, ListChecks, LogOut, MessageSquare, Monitor, Moon, Settings, Sun, User, Users } from 'lucide-react';
import { useActiveFirm, useApp } from 'shared-ui';
import { useTheme, type ThemeChoice } from '../lib/theme';

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';

const PRIMARY = [
  { to: '/clients', label: 'Clients', icon: Users },
  { to: '/matters', label: 'Matters', icon: Briefcase },
  { to: '/tasks', label: 'Tasks', icon: ListChecks },
  { to: '/messages', label: 'Messages', icon: MessageSquare },
];

const SECONDARY = [
  { to: '/settings/firm', label: 'Firm & members', icon: Building2 },
  { to: '/settings/account', label: 'Settings', icon: Settings },
  { to: '/settings/billing', label: 'Billing', icon: CreditCard },
  { to: '/settings/usage', label: 'Usage', icon: BarChart3 },
];

export function AppSidebar() {
  const { pathname } = useLocation();
  const { setOpenMobile, isMobile } = useSidebar();
  const closeOnMobile = () => isMobile && setOpenMobile(false);

  const item = ({ to, label, icon: Icon }: (typeof PRIMARY)[number]) => {
    const active = pathname === to || pathname.startsWith(`${to}/`);
    return (
      <SidebarMenuItem key={to}>
        <SidebarMenuButton asChild isActive={active} tooltip={label}>
          <NavLink to={to} onClick={closeOnMobile} aria-current={active ? 'page' : undefined}>
            <Icon />
            <span>{label}</span>
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar collapsible="icon" aria-label="Main navigation">
      <SidebarHeader>
        <FirmSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Practice</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{PRIMARY.map(item)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>{SECONDARY.map(item)}</SidebarMenu>
        <SidebarSeparator className="mx-0" />
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function FirmSwitcher() {
  const firm = useActiveFirm();
  const navigate = useNavigate();
  const initial = firm.activeOrg.name.trim()[0]?.toUpperCase() ?? 'F';
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" aria-label={`Firm: ${firm.activeOrg.name}. Switch firm`}>
              <span className="flex aspect-square size-8 items-center justify-center rounded-md bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">{initial}</span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold text-sidebar-accent-foreground">{firm.activeOrg.name}</span>
                <span className="truncate text-xs capitalize opacity-70">Leagentex · {firm.role}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4 opacity-60" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64" align="start" side="bottom" sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Your firms</DropdownMenuLabel>
            {firm.orgs.map((o) => (
              <DropdownMenuItem
                key={o.id}
                onSelect={() => {
                  if (o.id === firm.orgId) return;
                  // Leave any page holding the other firm's record ids before the firm scope remounts.
                  navigate('/clients');
                  void firm.switchFirm(o.id);
                }}
              >
                <span className="flex size-6 items-center justify-center rounded border text-xs font-medium">{o.name.trim()[0]?.toUpperCase()}</span>
                <span className="flex-1 truncate">{o.name}</span>
                {o.id === firm.orgId && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/settings/firm')}>
              <Building2 /> Firm &amp; members
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Signed-in user at the bottom of the sidebar: account, theme, log out. */
function UserMenu() {
  const { profile, signOut } = useApp();
  const navigate = useNavigate();
  const theme = useTheme();
  const { isMobile, setOpenMobile } = useSidebar();
  const go = (to: string) => {
    if (isMobile) setOpenMobile(false);
    navigate(to);
  };
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" aria-label={`Account menu for ${profile.fullName}`} tooltip={profile.fullName}>
              <span className="flex aspect-square size-8 items-center justify-center rounded-full bg-teal-700 text-xs font-semibold text-white">{profile.initials}</span>
              <span className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium text-sidebar-accent-foreground">{profile.fullName}</span>
                <span className="truncate text-xs opacity-70">{profile.email}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4 opacity-60" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60" side={isMobile ? 'top' : 'right'} align="end" sideOffset={8}>
            <DropdownMenuLabel className="font-normal">
              <div className="truncate text-sm font-medium">{profile.fullName}</div>
              <div className="truncate text-xs text-muted-foreground">{profile.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => go('/settings/account')}>
              <User /> Account
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => go('/settings/firm')}>
              <Settings /> Firm settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div role="radiogroup" aria-label="Theme" className="flex items-center gap-1 px-1 py-1">
              {THEMES.map(({ value, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={value}
                  role="radio"
                  aria-checked={theme.choice === value}
                  aria-label={`${label} theme`}
                  title={label}
                  className="flex-1 justify-center data-[checked=true]:bg-accent data-[checked=true]:text-accent-foreground"
                  data-checked={theme.choice === value}
                  onSelect={(e) => {
                    e.preventDefault(); // keep the menu open while trying themes
                    theme.setChoice(value);
                  }}
                >
                  <Icon />
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()} className="text-destructive focus:text-destructive">
              <LogOut /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
