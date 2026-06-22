import Dropdown from './Dropdown';
import type { DeepDepth } from '../lib/api';

export type ResearchModeValue = 'instant' | `deep-${DeepDepth}`;

interface ModeDropdownProps {
  value: ResearchModeValue;
  onChange: (value: ResearchModeValue) => void;
}

export default function ModeDropdown({ value, onChange }: ModeDropdownProps) {
  return (
    <Dropdown
      value={value}
      accent={value !== 'instant'}
      options={[
        { value: 'instant', label: 'Instant' },
        { value: 'deep-low', label: 'Deep Low' },
        { value: 'deep-med', label: 'Deep Med' },
        { value: 'deep-high', label: 'Deep High' },
        { value: 'deep-ultra', label: 'Deep Ultra' },
      ]}
      onChange={v => onChange(v as ResearchModeValue)}
    />
  );
}
