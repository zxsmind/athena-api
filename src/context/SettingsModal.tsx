import { createContext, useContext, useState, type ReactNode } from 'react';

interface SettingsModalContextType {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}

const SettingsModalContext = createContext<SettingsModalContextType>({
  open: () => {},
  close: () => {},
  isOpen: false,
});

export function SettingsModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <SettingsModalContext.Provider value={{
      open: () => setIsOpen(true),
      close: () => setIsOpen(false),
      isOpen,
    }}>
      {children}
    </SettingsModalContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSettingsModal() {
  return useContext(SettingsModalContext);
}
