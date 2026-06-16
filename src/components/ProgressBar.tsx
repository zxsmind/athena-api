interface ProgressBarProps {
  visible: boolean;
}

export default function ProgressBar({ visible }: ProgressBarProps) {
  if (!visible) return null;
  return (
    <div className="progress-bar-track">
      <div className="progress-bar-fill" />
    </div>
  );
}
