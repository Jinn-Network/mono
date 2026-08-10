/**
 * The injected environment every operation receives (spec §5.1).
 *
 * Nothing here touches ambient process state: `workspaceDir` names the
 * workspace explicitly (workspaces are never auto-discovered upward, per
 * `workspace.ts`'s own header), `principal` is the acting identity attributed
 * in the audit journal (§4.4), and `clock` is injected so an operation's
 * output — including every timestamp it writes — is a pure function of its
 * inputs, never of the wall clock.
 */
export interface OperationContext {
  readonly workspaceDir: string;
  /** The acting principal identity (sponsor or specific delegated agent, spec §4.2). */
  readonly principal: string;
  /** Returns an RFC 3339 timestamp. Injected so outputs are functions of inputs. */
  readonly clock: () => string;
}
