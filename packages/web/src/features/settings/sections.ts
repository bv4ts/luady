import type { ComponentType } from 'react';
import { ChannelsSettings } from '../channels/ChannelsSettings.js';
import { HostsSettings } from '../hosts/HostsSettings.js';
import { RoomsSettings } from '../rooms/RoomsSettings.js';
import { SetupLinks } from '../setup/SetupLinks.js';
import { AuditLog } from './AuditLog.js';
import { GeneralSettings } from './GeneralSettings.js';
import { OfficePrefs } from './OfficePrefs.js';
import { SecurityPanel } from './SecurityPanel.js';
import { SettingsForm } from './SettingsForm.js';

/**
 * Where a section sits on the page: the main column, the side column, or across the page (below both). The page
 * puts the notification form on the left, the panels on the right and the audit log below.
 */
export type SettingsArea = 'main' | 'side' | 'wide';

export interface SettingsSection {
  readonly id: string;
  readonly title: string;
  /** Lower first, within its area. */
  readonly order: number;
  readonly area: SettingsArea;
  readonly component: ComponentType;
}

/**
 * The Settings registry: every section with its own component. A new section is one entry here.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'general', title: 'General', order: 10, area: 'main', component: GeneralSettings },
  { id: 'notifications', title: 'Notifications', order: 20, area: 'main', component: SettingsForm },
  { id: 'office', title: 'The office', order: 10, area: 'side', component: OfficePrefs },
  { id: 'rooms', title: 'Rooms', order: 20, area: 'side', component: RoomsSettings },
  { id: 'hosts', title: 'Servers', order: 30, area: 'side', component: HostsSettings },
  { id: 'channels', title: 'Channels', order: 40, area: 'side', component: ChannelsSettings },
  { id: 'security', title: 'Security', order: 60, area: 'side', component: SecurityPanel },
  { id: 'setup', title: 'Setup', order: 70, area: 'side', component: SetupLinks },
  { id: 'audit', title: 'Audit log', order: 10, area: 'wide', component: AuditLog },
];

/** The sections of one area, in order. */
export function sectionsIn(area: SettingsArea, sections: readonly SettingsSection[] = SETTINGS_SECTIONS): SettingsSection[] {
  return sections.filter((section) => section.area === area).sort((a, b) => a.order - b.order);
}
