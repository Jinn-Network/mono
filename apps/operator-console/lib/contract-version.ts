export type ContractVersion = { major: number; minor: number };

/** Console's supported read-contract version (headless §8 artifact 3). */
export const CONSOLE_CONTRACT_VERSION: ContractVersion = { major: 1, minor: 0 };
