import { WorkspaceShell } from "@/components/workspace-shell";

export default function WorkspaceLayout({ children }: { readonly children: React.ReactNode }) {
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
