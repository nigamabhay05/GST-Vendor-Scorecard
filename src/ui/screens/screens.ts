/** The six steps, in the order the work happens. Shared by the rail and the router. */

export type ScreenId =
  | 'start'
  | 'files'
  | 'dataHealth'
  | 'scorecard'
  | 'findings'
  | 'exports'
  | 'supplier';

export interface ScreenDefinition {
  id: ScreenId;
  label: string;
  /** Screens that show results cannot be reached while Data Health is blocking. */
  requiresHealthAcknowledged: boolean;
}

export const SCREENS: readonly ScreenDefinition[] = [
  { id: 'start', label: 'Start', requiresHealthAcknowledged: false },
  { id: 'files', label: 'Files and mapping', requiresHealthAcknowledged: false },
  { id: 'dataHealth', label: 'Data health', requiresHealthAcknowledged: false },
  { id: 'scorecard', label: 'Scorecard', requiresHealthAcknowledged: true },
  { id: 'findings', label: 'Findings', requiresHealthAcknowledged: true },
  { id: 'exports', label: 'Exports', requiresHealthAcknowledged: true },
];
