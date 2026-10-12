import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ToastProvider } from './components/ui';
import { SearchPage } from './playground/SearchPage';
import { ContentsPage } from './playground/ContentsPage';
import { ResearchPage } from './playground/ResearchPage';
import { McpPage } from './playground/McpPage';
import { DocsPage } from './playground/DocsPage';
import { AdminLayout } from './admin/AdminLayout';
import { AdminDashboard } from './admin/DashboardPage';
import { AdminKeys } from './admin/KeysPage';
import { AdminJobs } from './admin/JobsPage';
import { AdminModels } from './admin/ModelsPage';
import { AdminSettings } from './admin/SettingsPage';
import { AdminOps } from './admin/OpsPage';

export default function App() {
  return (
    <ToastProvider>
      <AppShell>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/contents" element={<ContentsPage />} />
          <Route path="/research" element={<ResearchPage />} />
          <Route path="/mcp" element={<McpPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="keys" element={<AdminKeys />} />
            <Route path="jobs" element={<AdminJobs />} />
            <Route path="models" element={<AdminModels />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="ops" element={<AdminOps />} />
          </Route>
        </Routes>
      </AppShell>
    </ToastProvider>
  );
}
