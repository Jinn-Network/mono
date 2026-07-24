export const OFFICIAL_AUTOPILOT_VERIFICATION_PROFILE = 'jinn-mono.v1';
export const OFFICIAL_AUTOPILOT_REPOSITORY = 'Jinn-Network/mono';

export function officialAutopilotProfileFailure(input: {
  repository: string;
  verificationProfile: string | undefined;
}): string | null {
  if (input.verificationProfile !== OFFICIAL_AUTOPILOT_VERIFICATION_PROFILE) {
    return (
      `unsupported Autopilot verification profile `
      + `'${input.verificationProfile ?? '<missing>'}'; `
      + `only '${OFFICIAL_AUTOPILOT_VERIFICATION_PROFILE}' is supported`
    );
  }
  if (input.repository !== OFFICIAL_AUTOPILOT_REPOSITORY) {
    return (
      `Autopilot verification profile '${OFFICIAL_AUTOPILOT_VERIFICATION_PROFILE}' `
      + `requires repository '${OFFICIAL_AUTOPILOT_REPOSITORY}', `
      + `got '${input.repository}'`
    );
  }
  return null;
}

export function assertOfficialAutopilotProfile(input: {
  repository: string;
  verificationProfile: string | undefined;
}): void {
  const failure = officialAutopilotProfileFailure(input);
  if (failure) throw new Error(failure);
}
