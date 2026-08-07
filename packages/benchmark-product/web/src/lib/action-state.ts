export type GuiActionState =
  | { readonly status: "idle" }
  | { readonly status: "success"; readonly result: unknown }
  | {
      readonly status: "error";
      readonly error: {
        readonly code: string;
        readonly detail: string;
        readonly issues?: readonly { readonly path: string; readonly message: string }[];
      };
    };

export const IDLE_ACTION_STATE: GuiActionState = { status: "idle" };
