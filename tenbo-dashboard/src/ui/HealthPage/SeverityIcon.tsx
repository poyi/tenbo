import { AlertOctagon, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import type { Severity } from '../../api/lib/health/types';
import { severityColor } from './severity';

const ICONS: Record<Severity, LucideIcon> = {
  critical: AlertOctagon,
  warning: AlertTriangle,
  info: Info,
};

interface Props {
  severity: Severity;
  size?: number;
  className?: string;
  'aria-label'?: string;
}

export function SeverityIcon({ severity, size = 14, className, ...rest }: Props) {
  const Icon = ICONS[severity];
  return (
    <Icon
      size={size}
      strokeWidth={2}
      color={severityColor(severity)}
      className={className}
      aria-label={rest['aria-label'] ?? severity}
    />
  );
}
