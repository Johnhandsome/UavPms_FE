export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export const statusTone = (status: string): StatusTone => {
  const value = status.toUpperCase();
  if (['READY', 'HEALTHY', 'AVAILABLE', 'ACCEPTED', 'COMPLETED', 'FEASIBLE', 'PASSED', 'ELIGIBLE'].includes(value)) return 'success';
  if (['WARNING', 'POSTPONED', 'RESERVED'].includes(value)) return 'warning';
  if (['CRITICAL', 'NOT_READY', 'INCOMPLETE', 'FAILED', 'UNAVAILABLE', 'EMERGENCY', 'EXPIRED', 'NOT_ELIGIBLE'].includes(value)) return 'danger';
  if (['IN_PROGRESS', 'EVALUATING', 'PENDING'].includes(value)) return 'info';
  return 'neutral';
};

export const statusLabel = (status: string): string => status.replaceAll('_', ' ').toLowerCase().replace(/(^| )\w/g, (letter) => letter.toUpperCase());
