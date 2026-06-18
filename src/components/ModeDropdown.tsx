import Dropdown from './Dropdown';

interface ModeDropdownProps {
  value: 'instant' | 'deep';
  setDeepMode: (v: boolean) => void;
}

export default function ModeDropdown({ value, setDeepMode }: ModeDropdownProps) {
  return (
    <Dropdown
      value={value}
      accent={value === 'deep'}
      options={[
        { value: 'instant', label: 'Instant' },
        { value: 'deep', label: 'Deep' },
      ]}
      onChange={v => setDeepMode(v === 'deep')}
    />
  );
}
