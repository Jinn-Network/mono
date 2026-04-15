/**
 * OLAS Operate Middleware CLI Wrapper
 *
 * This utility provides a TypeScript wrapper around the olas-operate-middleware
 * Python CLI tool. It executes commands as child processes and parses the output.
 *
 * Part of JINN-149 Slice 1: Middleware Integration & Configuration
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'net';
import { logger } from '../logging/index.js';
import { config, secrets } from '../config/index.js';

const operateLogger = logger.child({ component: "OLAS-OPERATE-WRAPPER" });
const RPC_ALIAS_CHAIN_NAMES = [
  'arbitrum_one',
  'base',
  'celo',
  'ethereum',
  'gnosis',
  'mode',
  'optimism',
  'polygon',
  'solana',
] as const;

export interface OperateCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface OperateConfig {
  middlewarePath?: string;
  /**
   * Working directory for Python process (where cwd is set).
   * For E2E tests, this should be different from middlewarePath to create .operate in isolation.
   */
  workingDirectory?: string;
  /**
   * Override the middleware .operate home directory.
   * If omitted, defaults to <cwd>/.operate where cwd is workingDirectory or middlewarePath.
   */
  operateHome?: string;
  timeout?: number;
  pythonBinary?: string;
  rpcUrl?: string;
  // JINN-194: Add environment variable defaults
  defaultEnv?: {
    operatePassword?: string;
    stakingProgram?: 'no_staking' | 'custom_staking';
    customStakingAddress?: string;
    chainLedgerRpc?: Record<string, string>; // e.g., { gnosis: "https://...", mode: "https://..." }
    // JINN-202: Add attended mode support
    attended?: boolean; // If true, middleware shows interactive prompts
  };
}

export interface OperateResult {
  success: boolean;
  error?: string;
}

export interface WalletResult extends OperateResult {
  wallet?: { address: string; mnemonic: string[] };
}

export interface SafeResult extends OperateResult {
  safeAddress?: string;
  transactionHash?: string;
}

export interface ServiceResult extends OperateResult {
  service?: Record<string, any>;
}

export interface ServicesResult extends OperateResult {
  services?: Record<string, any>[];
}

export interface DeploymentResult extends OperateResult {
  deployment?: Record<string, any>;
}

export interface FundingRequirementsResult extends OperateResult {
  requirements?: Record<string, any>;
}

export interface DeploymentsResult extends OperateResult {
  deployments?: Record<string, any>;
}

export interface RecoveryResult extends OperateResult {
  data?: Record<string, any>;
}

export interface RecoveryRequirementsResult extends OperateResult {
  requirements?: Record<string, any>;
}

export class OlasOperateWrapper {
  private middlewarePath: string;
  private workingDirectory: string | null;
  private timeout: number;
  private pythonBinary: string;
  private serverProcess: ChildProcess | null = null;
  private serverHost: string = 'localhost';
  private serverPort: number = 8000;
  private isServerReady: boolean = false;
  private rpcUrl: string | null = null;
  private config: OperateConfig; // JINN-194: Store config for env var access
  private static serverPortCounter: number = 8000; // Static counter for port allocation
  private password: string | null = null; // Store password for session persistence

  private constructor(middlewarePath: string, pythonBinary: string, timeout: number, rpcUrl: string | null, config: OperateConfig) {
    this.middlewarePath = middlewarePath;
    this.workingDirectory = config.workingDirectory || null;
    this.pythonBinary = pythonBinary;
    this.timeout = timeout;
    this.rpcUrl = rpcUrl;
    this.config = config;

    // Allocate a unique port for this instance to prevent conflicts
    this.serverPort = OlasOperateWrapper.serverPortCounter++;

    operateLogger.info({
      middlewarePath: this.middlewarePath,
      timeout: this.timeout,
      pythonBinary: this.pythonBinary,
      rpcUrl: this.rpcUrl,
      serverPort: this.serverPort,
    }, "OlasOperateWrapper initialized");
  }

  /**
   * Create an OlasOperateWrapper instance with proper path and Python resolution
   */
  static async create(config: OperateConfig = {}): Promise<OlasOperateWrapper> {
    const middlewarePath = await OlasOperateWrapper._resolveMiddlewarePath(config.middlewarePath);
    const pythonBinary = await OlasOperateWrapper._resolvePythonBinary(middlewarePath, config.pythonBinary);
    const timeout = config.timeout || 300000; // 5 minutes for wallet/safe operations
    const rpcUrl = config.rpcUrl || null;

    const wrapper = new OlasOperateWrapper(middlewarePath, pythonBinary, timeout, rpcUrl, config);

    // If using poetry mode (E2E tests with copied middleware), install dependencies first
    if (pythonBinary === 'poetry') {
      operateLogger.info({ middlewarePath }, "Poetry mode detected - installing dependencies...");
      const installResult = await OlasOperateWrapper._spawnChildProcess('poetry', ['install'], {
        cwd: middlewarePath,
        timeout: 120000, // 2 minutes for dependency installation
        stream: true
      });

      if (!installResult.success) {
        operateLogger.error({
          stderr: installResult.stderr,
          stdout: installResult.stdout
        }, "Failed to install Poetry dependencies");
        throw new Error(`Poetry install failed: ${installResult.stderr}`);
      }

      operateLogger.info("Poetry dependencies installed successfully");
    }

    return wrapper;
  }

  /**
   * Resolve middleware path - checks config, env var, Poetry package, then fallback
   *
   * With Poetry git dependencies, the middleware is installed in the venv's site-packages,
   * not as a standalone directory. This method returns either:
   * - An explicit path (config or env var) for local development
   * - The jinn-node root (for Poetry mode - commands run via `poetry run python`)
   * - A fallback sibling directory (monorepo compatibility)
   */
  private static async _resolveMiddlewarePath(configPath?: string): Promise<string> {
    // 1. Explicit config path (e.g., for E2E tests with copied middleware)
    if (configPath) {
      operateLogger.debug({ configPath }, "Using config-provided middleware path");
      return resolve(configPath);
    }

    // 2. Environment variable override
    if (process.env.OLAS_MIDDLEWARE_PATH) {
      operateLogger.debug({ envPath: process.env.OLAS_MIDDLEWARE_PATH }, "Using OLAS_MIDDLEWARE_PATH env var");
      return resolve(process.env.OLAS_MIDDLEWARE_PATH);
    }

    const jinnNodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

    // 3. Check if Poetry has the middleware installed (via git dependency in pyproject.toml)
    try {
      const { execSync } = await import('child_process');
      // Use Python to check if the operate module is importable
      execSync('poetry run python -c "import operate"', {
        cwd: jinnNodeRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      // Middleware is installed via Poetry - return jinn-node root
      // Commands will be executed via `poetry run python -m operate.cli`
      operateLogger.info({ jinnNodeRoot }, "Middleware available via Poetry - using jinn-node root");
      return jinnNodeRoot;
    } catch {
      // Poetry not available or middleware not installed - continue to fallback
      operateLogger.debug("Poetry middleware not available, trying fallback paths");
    }

    // 4. Fallback: use jinn-node root (middleware should be installed via Poetry)
    operateLogger.warn(
      { jinnNodeRoot },
      "Poetry middleware check failed — falling back to jinn-node root. " +
      "Ensure olas-operate-middleware is installed: cd jinn-node && poetry install"
    );

    return jinnNodeRoot;
  }

  /**
   * Resolve Python binary, preferring Poetry for managed environments
   *
   * For standalone jinn-node with Poetry git dependencies, we use 'poetry run python'
   * which ensures the correct virtualenv with all dependencies is used.
   */
  private static async _resolvePythonBinary(middlewarePath: string, configBinary?: string): Promise<string> {
    // If explicit binary configured, use it
    if (configBinary) {
      operateLogger.info({ configBinary }, "Using configured Python binary");
      return configBinary;
    }

    const fs = await import('fs');

    // Check if pyproject.toml exists (indicating Poetry project)
    const pyprojectPath = join(middlewarePath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      // Verify Poetry is available
      try {
        const { execSync } = await import('child_process');
        execSync('poetry --version', { stdio: 'pipe' });

        operateLogger.info({
          middlewarePath,
          pyprojectPath
        }, "Found pyproject.toml - will use 'poetry run python'");
        return 'poetry';
      } catch {
        operateLogger.warn("Poetry not available but pyproject.toml exists - falling back to python3");
      }
    }

    // Try to find a Poetry venv Python directly (for copied middleware with .venv)
    try {
      const poetryResult = await OlasOperateWrapper._executePoetryEnvInfo(middlewarePath);
      if (poetryResult.success && poetryResult.stdout.trim()) {
        const venvPath = poetryResult.stdout.trim();
        const venvPython = join(venvPath, 'bin', 'python');

        if (fs.existsSync(venvPython)) {
          operateLogger.info({ venvPython }, "Resolved Poetry virtual environment Python");
          return venvPython;
        }
      }
    } catch (error) {
      operateLogger.debug({ error }, "Could not resolve Poetry venv directly");
    }

    // Fall back to python3
    operateLogger.info("Using fallback Python binary: python3");
    return 'python3';
  }

  /**
   * Execute poetry env info to get virtual environment path
   */
  private static async _executePoetryEnvInfo(middlewarePath: string): Promise<OperateCommandResult> {
    return OlasOperateWrapper._spawnChildProcess('poetry', ['env', 'info', '-p'], {
      cwd: middlewarePath,
      timeout: 5000
    });
  }

  /**
   * Generic child process spawning utility to reduce duplication
   */
  private static async _spawnChildProcess(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number; env?: Record<string, string>; stream?: boolean; interactive?: boolean } = {}
  ): Promise<OperateCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        // Use 'inherit' for stdin in interactive mode to allow user input
        stdio: options.interactive ? ['inherit', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        const chunk = data.toString();
        // Prevent buffer overflow by limiting output size
        if (stdout.length + chunk.length < 1024 * 1024) { // 1MB limit
          stdout += chunk;
        }
        // Stream through to console when requested
        if (options.stream) {
          process.stdout.write(chunk);
        }
      });

      child.stderr?.on('data', (data) => {
        const chunk = data.toString();
        // Prevent buffer overflow by limiting output size
        if (stderr.length + chunk.length < 1024 * 1024) { // 1MB limit
          stderr += chunk;
        }
        // Stream through to console when requested
        if (options.stream) {
          process.stderr.write(chunk);
        }
      });

      const timeout = options.timeout || 30000;
      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          success: false,
          stdout,
          stderr: stderr + '\nCommand timed out',
          exitCode: null
        });
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        resolve({
          success: false,
          stdout,
          stderr: stderr + '\n' + error.message,
          exitCode: null
        });
      });
    });
  }

  /**
   * Build default environment variables for CLI commands
   * JINN-194: Support for required environment variables
   * @private
   */
  private _buildDefaultEnv(): Record<string, string> {
    const env: Record<string, string> = this._buildRpcAliasEnv();

    // JINN-202: Support both attended (interactive) and unattended (programmatic) modes
    // - attended=true: Middleware shows funding prompts (for interactive setup)
    // - attended=false: No prompts, requires all env vars set (for worker automation)
    if (this.config.defaultEnv?.attended !== undefined) {
      env.ATTENDED = this.config.defaultEnv.attended ? 'true' : 'false';
    } else {
      // Default to unattended mode for backward compatibility
      env.ATTENDED = 'false';
    }

    // Add OPERATE_PASSWORD if configured
    if (this.config.defaultEnv?.operatePassword) {
      env.OPERATE_PASSWORD = this.config.defaultEnv.operatePassword;
      operateLogger.info({
        passwordSet: true,
        passwordLength: this.config.defaultEnv.operatePassword.length
      }, "OPERATE_PASSWORD configured in env");
    } else {
      operateLogger.warn("OPERATE_PASSWORD not set in config.defaultEnv");
    }

    // Add STAKING_PROGRAM if configured
    if (this.config.defaultEnv?.stakingProgram) {
      env.STAKING_PROGRAM = this.config.defaultEnv.stakingProgram;
    }

    return env;
  }

  /**
   * Build a full RPC alias map from the canonical runtime RPC URL.
   *
   * Operator contract:
   * - `RPC_URL` is the only required input.
   *
   * Runtime compatibility:
   * - Populate all known alias env vars consumed by operate/autonomy internals.
   * - Preserve optional chain-specific overrides when provided via chainLedgerRpc.
   */
  private _buildRpcAliasEnv(): Record<string, string> {
    const chainSpecificRpcs = new Map<string, string>();

    if (this.config.defaultEnv?.chainLedgerRpc) {
      for (const [chain, rpcUrl] of Object.entries(this.config.defaultEnv.chainLedgerRpc)) {
        const normalizedChain = this._normalizeChainName(chain);
        const normalizedRpc = rpcUrl?.trim();
        if (normalizedChain && normalizedRpc) {
          chainSpecificRpcs.set(normalizedChain, normalizedRpc);
        }
      }
    }

    const canonicalRpc =
      this._resolveCanonicalRpcUrl() ??
      chainSpecificRpcs.values().next().value ??
      null;

    if (!canonicalRpc) {
      return {};
    }

    const env: Record<string, string> = {
      RPC_URL: canonicalRpc,
      CUSTOM_CHAIN_RPC: canonicalRpc,
    };

    const chainAliasNames = Array.from(
      new Set<string>([...RPC_ALIAS_CHAIN_NAMES, ...chainSpecificRpcs.keys()])
    );

    for (const chain of chainAliasNames) {
      const chainRpc = chainSpecificRpcs.get(chain) ?? canonicalRpc;
      const prefix = chain.toUpperCase();
      env[`${prefix}_RPC`] = chainRpc;
      env[`${prefix}_LEDGER_RPC`] = chainRpc;
      env[`${prefix}_CHAIN_RPC`] = chainRpc;
    }

    return env;
  }

  private _resolveCanonicalRpcUrl(): string | null {
    const configuredRpc = this.rpcUrl?.trim();
    if (configuredRpc) {
      return configuredRpc;
    }

    const configRpc = secrets.rpcUrl;
    if (configRpc) {
      return configRpc;
    }

    return null;
  }

  private _normalizeChainName(chain: string): string {
    return chain.trim().toLowerCase().replace(/-/g, '_');
  }

  /**
   * Return only RPC alias key names for safe logging (no endpoint values).
   */
  private _getRpcAliasLogKeys(env: Record<string, string>): string[] {
    return Object.keys(env)
      .filter(
        (k) =>
          k === 'RPC_URL' ||
          k === 'CUSTOM_CHAIN_RPC' ||
          k.endsWith('_RPC') ||
          k.endsWith('_CHAIN_RPC') ||
          k.endsWith('_LEDGER_RPC')
      )
      .sort();
  }

  /**
   * Execute an operate CLI command
   * @param command The operate command (e.g., 'agent', 'service')
   * @param args Command arguments
   * @param options Additional options
   */
  async executeCommand(
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: Record<string, string>; stream?: boolean; timeoutMs?: number; interactive?: boolean } = {}
  ): Promise<OperateCommandResult> {
    // Use workingDirectory if set (for E2E isolation), otherwise use middlewarePath
    const cwd = options.cwd || this.workingDirectory || this.middlewarePath;

    // JINN-194: Merge default environment variables with options
    const env = {
      ...this._buildDefaultEnv(),
      ...options.env,
    };

    // For E2E tests with copied middleware, use 'poetry run python' instead of direct Python
    // This works because Poetry detects pyproject.toml and handles venv automatically
    let actualCommand: string;
    let actualArgs: string[];

    if (this.pythonBinary === 'poetry') {
      // Use poetry run python for copied middleware
      actualCommand = 'poetry';
      actualArgs = ['run', 'python', '-m', 'operate.cli', command, ...args];
      operateLogger.info("Using 'poetry run python' for copied middleware");
    } else {
      // Use resolved Python binary directly
      actualCommand = this.pythonBinary;
      actualArgs = ['-m', 'operate.cli', command, ...args];
    }

    operateLogger.info({
      command,
      args,
      actualCommand,
      actualArgs,
      cwd,
      middlewarePath: this.middlewarePath,
      workingDirectory: this.workingDirectory,
      envVars: {
        ATTENDED: env.ATTENDED,
        STAKING_PROGRAM: env.STAKING_PROGRAM,
        hasOperatePassword: typeof env.OPERATE_PASSWORD === 'string' && env.OPERATE_PASSWORD.length > 0,
        operatePasswordLength: env.OPERATE_PASSWORD?.length,
        RPC_ALIAS_KEYS: this._getRpcAliasLogKeys(env)
      }
    }, "Executing operate command with environment");

    const result = await OlasOperateWrapper._spawnChildProcess(actualCommand, actualArgs, {
      cwd,
      env,
      timeout: options.timeoutMs ?? this.timeout,
      stream: options.stream,
      interactive: options.interactive
    });

    // Log command completion details
    operateLogger.debug({
      command,
      args,
      exitCode: result.exitCode,
      success: result.success,
      stdoutLength: result.stdout.length,
      stderrLength: result.stderr.length
    }, "Command completed");

    if (!result.success) {
      if (result.stderr.includes('timed out')) {
        operateLogger.warn({ command, args }, "Command timeout, killing process");
      } else {
        operateLogger.error({
          command,
          args,
          exitCode: result.exitCode,
          stderr: result.stderr.substring(0, 500) // Limit error logging
        }, "Command failed");
      }
    }

    return result;
  }

  /**
   * Get the operate CLI version
   */
  async getVersion(): Promise<string | null> {
    try {
      const result = await this.executeCommand('--version');
      if (result.success && result.stdout) {
        return result.stdout.trim();
      }
      return null;
    } catch (error) {
      operateLogger.error({ error }, "Failed to get operate version");
      return null;
    }
  }

  /**
   * Check if the operate CLI is available and functional
   */
  async checkHealth(): Promise<boolean> {
    try {
      const version = await this.getVersion();
      const isHealthy = version !== null;

      operateLogger.info({
        isHealthy,
        version
      }, "Health check completed");

      return isHealthy;
    } catch (error) {
      operateLogger.error({ error }, "Health check failed");
      return false;
    }
  }

  /**
   * Validate Python environment and dependencies
   */
  async validateEnvironment(): Promise<{ isValid: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      const pythonIssues = await this._validatePythonEnvironment();
      const pathIssues = await this._validateMiddlewarePath();

      issues.push(...pythonIssues, ...pathIssues);
    } catch (error) {
      issues.push(`Environment validation error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const isValid = issues.length === 0;

    operateLogger.info({
      isValid,
      issueCount: issues.length,
      issues: isValid ? undefined : issues
    }, "Environment validation completed");

    return { isValid, issues };
  }

  /**
   * Validate Python binary and CLI availability
   */
  private async _validatePythonEnvironment(): Promise<string[]> {
    const issues: string[] = [];
    const pythonCheck = await this.executeCommand('--version');

    if (!pythonCheck.success) {
      if (pythonCheck.stderr.includes('ModuleNotFoundError')) {
        if (pythonCheck.stderr.includes("No module named 'autonomy'")) {
          issues.push('AEA/Autonomy framework not installed. Run: poetry install');
        } else if (pythonCheck.stderr.includes("No module named 'psutil'")) {
          issues.push('Basic Python dependencies missing. Install psutil and other requirements.');
        } else {
          issues.push(`Missing Python module: ${pythonCheck.stderr}`);
        }
      } else if (pythonCheck.stderr.includes('command not found') || pythonCheck.stderr.includes('No such file')) {
        issues.push(`Python binary '${this.pythonBinary}' not found. Check PATH or configure pythonBinary in OlasOperateWrapper.`);
      } else {
        issues.push(`CLI execution failed: ${pythonCheck.stderr.substring(0, 200)}`);
      }
    }

    return issues;
  }

  /**
   * Validate middleware availability
   *
   * For Poetry-installed middleware, we can't check for a file path since it's in site-packages.
   * Instead, we verify the operate module is importable.
   */
  private async _validateMiddlewarePath(): Promise<string[]> {
    const issues: string[] = [];

    // If using Poetry mode, verify the module is importable
    if (this.pythonBinary === 'poetry') {
      try {
        const result = await OlasOperateWrapper._spawnChildProcess(
          'poetry',
          ['run', 'python', '-c', 'import operate; print(operate.__version__)'],
          { cwd: this.middlewarePath, timeout: 10000 }
        );
        if (!result.success) {
          issues.push(`Middleware not installed via Poetry. Run: cd ${this.middlewarePath} && poetry install`);
        }
      } catch {
        issues.push(`Failed to verify Poetry middleware installation at ${this.middlewarePath}`);
      }
      return issues;
    }

    // For direct Python mode, check for cli.py file
    try {
      const fs = await import('fs/promises');
      const cliPath = `${this.middlewarePath}/operate/cli.py`;
      await fs.access(cliPath);
    } catch {
      issues.push(`Middleware not found at ${this.middlewarePath}. Ensure middleware is installed.`);
    }

    return issues;
  }

  /**
   * Execute an agent-related command
   * @param subcommand The agent subcommand (e.g., 'register', 'create')
   * @param args Additional arguments
   */
  async executeAgentCommand(
    subcommand: string,
    args: string[] = [],
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<OperateCommandResult> {
    return this.executeCommand('agent', [subcommand, ...args], options);
  }

  /**
   * Execute a service-related command
   * @param subcommand The service subcommand (e.g., 'create', 'stake', 'unstake')
   * @param args Additional arguments
   */
  async executeServiceCommand(
    subcommand: string,
    args: string[] = [],
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<OperateCommandResult> {
    return this.executeCommand('service', [subcommand, ...args], options);
  }

  /**
   * Parse JSON output from operate commands
   * @param result The command result
   */
  parseJsonOutput<T = any>(result: OperateCommandResult): T | null {
    if (!result.success || !result.stdout) {
      return null;
    }

    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      operateLogger.error({
        error,
        stdout: result.stdout.substring(0, 200)
      }, "Failed to parse JSON output");
      return null;
    }
  }

  /**
   * Start the operate HTTP server
   */
  private async _startServer(): Promise<{ success: boolean; error?: string }> {
    if (this.serverProcess && !this.serverProcess.killed) {
      operateLogger.info({ serverPort: this.serverPort }, "Server is already running");
      return { success: true };
    }

    try {
      // Ensure any previous server on this port is stopped
      await this._ensurePortAvailable();

      const cwd = this.workingDirectory || this.middlewarePath;
      const operateHome = this.config.operateHome
        ? resolve(cwd, this.config.operateHome)
        : join(cwd, '.operate');
      const args = [
        '-m',
        'operate.cli',
        'daemon',
        `--port=${this.serverPort}`,
        `--home=${operateHome}`,
      ];
      const usePoetry = this.pythonBinary === 'poetry';
      const actualCommand = usePoetry ? 'poetry' : this.pythonBinary;
      const actualArgs = usePoetry ? ['run', 'python', ...args] : args;
      const env: Record<string, string> = {
        ...this._buildRpcAliasEnv(),
        OPERATE_HOME: operateHome,
      };

      operateLogger.info({
        command: actualCommand,
        args: actualArgs,
        cwd,
        operateHome,
        serverPort: this.serverPort
      }, "Starting operate server");

      this.serverProcess = spawn(actualCommand, actualArgs, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      });

      // Catch spawn errors (e.g. ENOENT when python3 is not installed)
      // Without this handler, the 'error' event becomes an unhandled exception
      this.serverProcess.on('error', (err) => {
        operateLogger.error({ error: err.message, code: (err as NodeJS.ErrnoException).code }, 'Server process spawn error');
      });

      this.serverProcess.stdout?.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          operateLogger.info({ stream: 'stdout' }, output);
        }
      });

      this.serverProcess.stderr?.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          // Filter out noisy, non-critical errors from middleware stderr
          const noisyPatterns = [
            'No Tendermint process listening',
            'SSL failed, trying HTTP fallback',
            'pkg_resources is deprecated',
            'Setuptools is replacing distutils',
          ];

          if (noisyPatterns.some(pattern => output.includes(pattern))) {
            operateLogger.debug({ stream: 'stderr' }, `Filtered out noisy log: ${output}`);
            return; // Don't show in console
          }

          // Middleware logs everything to stderr, including INFO messages
          // Parse the log level from the output if possible
          const logLevel = output.match(/\[(ERROR|WARN|WARNING|INFO|DEBUG)\]/i);

          if (logLevel) {
            const level = logLevel[1].toUpperCase();
            // Only log ERROR and WARN to our logs, suppress INFO/DEBUG from middleware
            if (level === 'ERROR' || level === 'WARN' || level === 'WARNING') {
              operateLogger.error({ stream: 'stderr' }, output);
            } else {
              // Suppress INFO and DEBUG middleware logs (too noisy)
              operateLogger.debug({ stream: 'stderr' }, output);
            }
          } else {
            // No log level marker - check for error indicators
            if (output.toLowerCase().includes('error') ||
              output.toLowerCase().includes('exception') ||
              output.toLowerCase().includes('traceback')) {
              operateLogger.error({ stream: 'stderr' }, output);
            } else {
              // Suppress non-error middleware output from the main console log
              operateLogger.debug({ stream: 'stderr' }, output);
            }
          }
        }
      });

      // Wait for server to be ready
      const readyResult = await this._waitForServerReady();
      if (!readyResult.success) {
        this._stopServer();
        return readyResult;
      }

      this.isServerReady = true;
      operateLogger.info({ host: this.serverHost, port: this.serverPort }, "Operate server started successfully");
      return { success: true };
    } catch (error) {
      operateLogger.error({ error }, "Failed to start operate server");
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error starting server'
      };
    }
  }

  /**
   * Stop the operate HTTP server
   */
  private _stopServer(): void {
    if (this.serverProcess && !this.serverProcess.killed) {
      operateLogger.info({ serverPort: this.serverPort }, "Stopping operate server");
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
    this.isServerReady = false;
  }

  /**
   * Ensure the port is available by attempting to stop any existing server
   */
  private async _ensurePortAvailable(): Promise<void> {
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const isFree = await this._isPortFree(this.serverPort);
      if (isFree) {
        operateLogger.debug({ serverPort: this.serverPort }, "Port appears to be available");
        return;
      }

      operateLogger.warn(
        { serverPort: this.serverPort },
        "Port already in use; selecting a new port"
      );
      this.serverPort = OlasOperateWrapper.serverPortCounter++;
    }

    throw new Error('Unable to find an available port for operate daemon');
  }

  private async _isPortFree(port: number): Promise<boolean> {
    return new Promise((resolvePort) => {
      const server = createServer();
      server.unref();
      server.on('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
          resolvePort(false);
        } else {
          resolvePort(false);
        }
      });
      server.listen(port, this.serverHost, () => {
        server.close(() => resolvePort(true));
      });
    });
  }

  /**
   * Wait for the server to be ready by polling the health endpoint
   */
  private async _waitForServerReady(maxAttempts: number = 60, delayMs: number = 2000): Promise<{ success: boolean; error?: string }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        operateLogger.debug({ attempt }, "Pinging server health endpoint...");
        const response = await fetch(`http://${this.serverHost}:${this.serverPort}/api`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000)
        });

        if (response.ok) {
          operateLogger.info({ attempt }, "Server health check passed");
          return { success: true };
        } else {
          operateLogger.debug({ attempt, status: response.status }, "Server health check failed with non-OK status");
        }
      } catch (error) {
        // Server not ready yet, continue polling
        operateLogger.debug({ attempt, error: error instanceof Error ? error.message : String(error) }, "Server health check failed, retrying");
      }

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    return {
      success: false,
      error: `Server failed to become ready after ${maxAttempts} attempts`
    };
  }

  /**
   * Handle common error scenarios and format error messages consistently
   */
  private _handleError(error: unknown, operation: string): string {
    const message = error instanceof Error ? error.message : String(error);
    return `${operation} failed: ${message}`;
  }

  /**
   * Ensure user is logged in before making API calls
   * The middleware's password state can be lost between requests, so we re-login proactively
   */
  private async _ensureLoggedIn(): Promise<{ success: boolean; error?: string }> {
    if (!this.password) {
      return { success: false, error: 'No password stored for re-login' };
    }

    try {
      const url = `http://${this.serverHost}:${this.serverPort}/api/account/login`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.password }),
        signal: AbortSignal.timeout(5000) // Short timeout for login
      });

      const data = await response.json();

      if (response.ok) {
        operateLogger.debug("Session refreshed via pre-request login");
        return { success: true };
      }

      return { success: false, error: data.error || `HTTP ${response.status}` };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Login request failed'
      };
    }
  }

  /**
   * Make an HTTP request to the operate server
   */
  async makeRequest(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    body?: any
  ): Promise<{ success: boolean; data?: any; error?: string; statusCode?: number }> {
    if (!this.isServerReady) {
      return {
        success: false,
        error: 'Server is not ready. Call _startServer() first.'
      };
    }

    // CRITICAL: Re-authenticate before EVERY API call to prevent "User not logged in" errors
    // The middleware's password state (operate.password) is process-scoped and can be lost
    // This ensures the session is always valid
    if (this.password && endpoint !== '/api/account/login') {
      const loginResult = await this._ensureLoggedIn();
      if (!loginResult.success) {
        operateLogger.warn({ endpoint }, "Pre-request login failed, continuing anyway");
      }
    }

    try {
      const url = `http://${this.serverHost}:${this.serverPort}${endpoint}`;
      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(this.timeout)
      };

      if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
      }

      operateLogger.info({ url, method, body }, "Making HTTP request to middleware");

      const response = await fetch(url, options);
      const data = await response.json();

      operateLogger.info({
        url,
        method,
        statusCode: response.status,
        statusText: response.statusText,
        responseData: data,
        ok: response.ok
      }, "Middleware HTTP response received");

      if (response.ok) {
        return { success: true, data, statusCode: response.status };
      } else {
        operateLogger.error({
          url,
          method,
          statusCode: response.status,
          statusText: response.statusText,
          errorData: data
        }, "Middleware returned error response");
        return {
          success: false,
          error: data.error || data.message || `HTTP ${response.status}: ${response.statusText}`,
          statusCode: response.status
        };
      }
    } catch (error) {
      operateLogger.error({ error, endpoint, method }, "HTTP request failed with exception");
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown HTTP error'
      };
    }
  }

  /**
   * Setup user account with password
   * This creates a new user account in the operate middleware
   * @param password The password for the user account (minimum 8 characters)
   */
  async setupUserAccount(password: string): Promise<OperateResult> {
    try {
      if (password.length < 8) {
        return {
          success: false,
          error: 'Password must be at least 8 characters long'
        };
      }

      const result = await this.makeRequest('/api/account', 'POST', { password });

      if (result.success) {
        operateLogger.info("User account setup completed successfully");
        this.password = password;
        return { success: true };
      } else {
        operateLogger.error({ error: result.error }, "User account setup failed");
        return {
          success: false,
          error: result.error || 'Account setup failed'
        };
      }
    } catch (error) {
      operateLogger.error({ error }, "Error during user account setup");
      return {
        success: false,
        error: this._handleError(error, 'Account setup')
      };
    }
  }

  /**
   * Log in a user with the specified password
   * @param password The user's password
   */
  async login(password: string): Promise<OperateResult> {
    try {
      const result = await this.makeRequest('/api/account/login', 'POST', { password });

      if (result.success) {
        operateLogger.info("User logged in successfully");
        this.password = password;
        return { success: true };
      }

      operateLogger.error({ error: result.error }, "Login failed");
      return {
        success: false,
        error: result.error || 'Login failed'
      };
    } catch (error) {
      operateLogger.error({ error }, "Error during login");
      return {
        success: false,
        error: this._handleError(error, 'Login')
      };
    }
  }

  /**
   * Create a new wallet with the specified ledger type
   * @param ledgerType The type of ledger (e.g., 'ethereum')
   */
  async createWallet(ledgerType: string = 'ethereum'): Promise<WalletResult> {
    try {
      const result = await this.makeRequest('/api/wallet', 'POST', { ledger_type: ledgerType });

      if (result.success && result.data) {
        const { wallet, mnemonic } = result.data;

        operateLogger.info({
          address: wallet.address,
          ledgerType
        }, "Wallet created successfully");

        return {
          success: true,
          wallet: {
            address: wallet.address,
            mnemonic: mnemonic || []
          }
        };
      }

      operateLogger.error({ error: result.error }, "Wallet creation failed");
      return {
        success: false,
        error: result.error || 'Wallet creation failed'
      };
    } catch (error) {
      operateLogger.error({ error }, "Error during wallet creation");
      return {
        success: false,
        error: this._handleError(error, 'Wallet creation')
      };
    }
  }

  /**
   * Import an existing wallet using a private key
   * @param privateKey The private key to import
   * @param ledgerType The type of ledger (e.g., 'ethereum')
   */
  async importWallet(privateKey: string, ledgerType: string = 'ethereum'): Promise<WalletResult> {
    try {
      const result = await this.makeRequest('/api/wallet/import', 'POST', {
        ledger_type: ledgerType,
        private_key: privateKey,
      });

      if (result.success && result.data) {
        operateLogger.info({
          address: result.data.address,
          ledgerType
        }, "Wallet imported successfully");

        return {
          success: true,
          wallet: {
            address: result.data.address,
            mnemonic: []
          }
        };
      }

      operateLogger.error({ error: result.error }, "Wallet import failed");
      return {
        success: false,
        error: result.error || 'Wallet import failed'
      };
    } catch (error) {
      operateLogger.error({ error }, "Error during wallet import");
      return {
        success: false,
        error: this._handleError(error, 'Wallet import')
      };
    }
  }

  /**
   * Create a Safe (Gnosis Safe) on the specified chain
   * @param chain The chain to deploy the Safe on (e.g., 'base', 'ethereum')
   * @param backupOwner Optional backup owner address
   * @param options Additional options for Safe creation
   */
  async createSafe(
    chain: string,
    backupOwner?: string,
    options: {
      checkExisting?: boolean; // If true, check if Safe already exists and return it
      warnIfNew?: boolean;     // If true, warn before creating a new Safe
    } = {}
  ): Promise<SafeResult> {
    try {
      // Check if Safe already exists for this chain
      if (options.checkExisting) {
        const existingSafe = await this.getExistingSafeForChain(chain);
        if (existingSafe) {
          operateLogger.info({
            safeAddress: existingSafe,
            chain
          }, "Safe already exists for this chain, reusing");
          return {
            success: true,
            safeAddress: existingSafe,
            transactionHash: undefined // No new tx, reusing existing Safe
          };
        }
      }

      // Warn if creating a new Safe
      if (options.warnIfNew) {
        operateLogger.warn({ chain }, "⚠️  Creating NEW Safe on chain. This will require funding.");
      }

      const requestBody: any = { chain, transfer_excess_assets: true };
      if (backupOwner) {
        requestBody.backup_owner = backupOwner;
      }

      const result = await this.makeRequest('/api/wallet/safe', 'POST', requestBody);

      if (result.success && result.data) {
        const safeAddress = result.data.safe;
        const transactionHash = result.data.create_tx;

        operateLogger.info({
          safeAddress,
          chain,
          backupOwner,
          transactionHash
        }, "Safe created successfully");

        return {
          success: true,
          safeAddress,
          transactionHash
        };
      }

      operateLogger.error({ error: result.error }, "Safe creation failed");
      return {
        success: false,
        error: result.error || 'Safe creation failed'
      };
    } catch (error) {
      operateLogger.error({ error }, "Error during Safe creation");
      return {
        success: false,
        error: this._handleError(error, 'Safe creation')
      };
    }
  }

  /**
   * Get existing Safe address for a chain from wallet info
   * @param chain The chain to check for existing Safe
   * @returns Safe address if exists, undefined otherwise
   */
  async getExistingSafeForChain(chain: string): Promise<string | undefined> {
    try {
      const walletInfo = await this.getWalletInfo();
      if (walletInfo.success && walletInfo.wallets && walletInfo.wallets.length > 0) {
        const wallet = walletInfo.wallets[0];
        if (wallet.safes && wallet.safes[chain]) {
          const safeAddr = wallet.safes[chain];
          // Verify it's not the zero address
          if (safeAddr && safeAddr !== "0x0000000000000000000000000000000000000000") {
            return safeAddr;
          }
        }
      }
      return undefined;
    } catch (error) {
      operateLogger.debug({ error, chain }, "Could not check for existing Safe");
      return undefined;
    }
  }

  /**
   * Get wallet information for the specified ledger type
   * @param ledgerType The ledger type to query
   */
  async getWalletInfo(ledgerType: string = 'ethereum'): Promise<{
    success: boolean;
    wallets?: Array<{
      address: string;
      ledger_type: string;
      safes?: Record<string, string>;
    }>;
    error?: string;
    safeAddress?: string;
  }> {
    try {
      const result = await this.makeRequest(`/api/wallet?ledger_type=${ledgerType}`);

      if (result.success && result.data) {
        const wallets = Array.isArray(result.data) ? result.data : [result.data];
        const primaryWallet = wallets[0];
        const safeAddress = primaryWallet?.safes?.base;

        operateLogger.debug({
          walletCount: wallets.length,
          ledgerType,
          safeAddress,
        }, "Retrieved wallet information");

        return {
          success: true,
          wallets,
          safeAddress,
        };
      }

      return {
        success: false,
        error: result.error || 'Failed to retrieve wallet information'
      };
    } catch (error) {
      operateLogger.error({ error }, "Error retrieving wallet information");
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error retrieving wallet info'
      };
    }
  }

  /**
   * Get all services from the middleware (v2 API)
   */
  async getServices(): Promise<ServicesResult> {
    const result = await this.makeRequest('/api/v2/services', 'GET');
    if (result.success) {
      return { success: true, services: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch services' };
  }

  /**
   * Get a single service by config id (v2 API)
   */
  async getService(serviceConfigId: string): Promise<ServiceResult> {
    const result = await this.makeRequest(`/api/v2/service/${serviceConfigId}`, 'GET');
    if (result.success) {
      return { success: true, service: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch service' };
  }

  /**
   * Create a service (v2 API)
   */
  async createService(serviceConfig: Record<string, any>): Promise<ServiceResult> {
    const result = await this.makeRequest('/api/v2/service', 'POST', {
      ...serviceConfig,
      deploy: false,
    });
    if (result.success) {
      return { success: true, service: result.data };
    }
    return { success: false, error: result.error || 'Failed to create service' };
  }

  /**
   * Update a service configuration (v2 API)
   */
  async updateService(
    serviceConfigId: string,
    partialConfig: Record<string, any>
  ): Promise<ServiceResult> {
    const result = await this.makeRequest(`/api/v2/service/${serviceConfigId}`, 'PATCH', partialConfig);
    if (result.success) {
      return { success: true, service: result.data };
    }
    return { success: false, error: result.error || 'Failed to update service' };
  }

  /**
   * Start a service deployment (v2 API)
   */
  async startService(serviceConfigId: string): Promise<ServiceResult> {
    const result = await this.makeRequest(`/api/v2/service/${serviceConfigId}`, 'POST');
    if (result.success) {
      return { success: true, service: result.data };
    }
    return { success: false, error: result.error || 'Failed to start service' };
  }

  /**
   * Stop a service deployment (v2 API)
   */
  async stopDeployment(serviceConfigId: string): Promise<DeploymentResult> {
    const result = await this.makeRequest(`/api/v2/service/${serviceConfigId}/deployment/stop`, 'POST');
    if (result.success) {
      return { success: true, deployment: result.data };
    }
    return { success: false, error: result.error || 'Failed to stop deployment' };
  }

  /**
   * Get deployment details for a service (v2 API)
   */
  async getDeployment(serviceConfigId: string): Promise<DeploymentResult> {
    const result = await this.makeRequest(`/api/v2/service/${serviceConfigId}/deployment`, 'GET');
    if (result.success) {
      return { success: true, deployment: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch deployment' };
  }

  /**
   * Get deployment details for all services (v2 API)
   */
  async getAllDeployments(): Promise<DeploymentsResult> {
    const result = await this.makeRequest('/api/v2/services/deployment', 'GET');
    if (result.success) {
      return { success: true, deployments: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch deployments' };
  }

  /**
   * Get funding requirements for a service (v2 API)
   */
  async getFundingRequirements(serviceConfigId: string): Promise<FundingRequirementsResult> {
    const result = await this.makeRequest(`/api/v2/service/${serviceConfigId}/funding_requirements`, 'GET');
    if (result.success) {
      return { success: true, requirements: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch funding requirements' };
  }

  /**
   * Fund a service safe (v2 API)
   */
  async fundService(
    serviceConfigId: string,
    funds: Record<string, any>
  ): Promise<OperateResult> {
    const result = await this.makeRequest(`/api/v2/service/${serviceConfigId}/fund`, 'POST', funds);
    if (result.success) {
      return { success: true };
    }
    return { success: false, error: result.error || 'Failed to fund service' };
  }

  /**
   * Get recovery status (api)
   */
  async getRecoveryStatus(): Promise<RecoveryResult> {
    const result = await this.makeRequest('/api/wallet/recovery/status', 'GET');
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch recovery status' };
  }

  /**
   * Get recovery funding requirements (api)
   */
  async getRecoveryFundingRequirements(): Promise<RecoveryRequirementsResult> {
    const result = await this.makeRequest('/api/wallet/recovery/funding_requirements', 'GET');
    if (result.success) {
      return { success: true, requirements: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch recovery requirements' };
  }

  /**
   * Prepare wallet recovery (api)
   */
  async prepareRecovery(newPassword: string): Promise<RecoveryResult> {
    const result = await this.makeRequest('/api/wallet/recovery/prepare', 'POST', {
      new_password: newPassword,
    });
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error || 'Failed to prepare recovery' };
  }

  /**
   * Complete wallet recovery (api)
   */
  async completeRecovery(): Promise<RecoveryResult> {
    const result = await this.makeRequest('/api/wallet/recovery/complete', 'POST');
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error || 'Failed to complete recovery' };
  }

  /**
   * Get extended wallet details (api)
   */
  async getExtendedWallet(): Promise<RecoveryResult> {
    const result = await this.makeRequest('/api/wallet/extended', 'GET');
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error || 'Failed to fetch extended wallet' };
  }

  /**
   * Bootstrap wallet operations - combines account setup, wallet creation, and Safe deployment
   * This is a convenience method that mirrors the functionality of the old wallet manager
   * @param config Bootstrap configuration
   */
  async bootstrapWallet(config: {
    password: string;
    ledgerType?: string;
    chain: string;
    backupOwner?: string;
  }): Promise<{
    success: boolean;
    walletAddress?: string;
    safeAddress?: string;
    mnemonic?: string[];
    error?: string;
  }> {
    const { password, ledgerType = 'ethereum', chain, backupOwner } = config;

    // Store password for session persistence
    this.password = password;

    try {
      // Step 0: Validate environment before starting
      operateLogger.info("Validating environment before bootstrap");
      const envValidation = await this.validateEnvironment();
      if (!envValidation.isValid) {
        return {
          success: false,
          error: `Environment validation failed: ${envValidation.issues.join(', ')}`
        };
      }

      // Step 1: Start server
      operateLogger.info("Starting operate server");
      const serverResult = await this._startServer();
      if (!serverResult.success) {
        return {
          success: false,
          error: `Failed to start server: ${serverResult.error}`
        };
      }

      try {
        // Step 2: Setup user account or login if account exists
        operateLogger.info("Setting up user account");
        const accountResult = await this.setupUserAccount(password);
        if (!accountResult.success) {
          // If account already exists, try to login instead
          if (accountResult.error?.includes('Account already exists')) {
            operateLogger.info("Account exists, attempting login");
            const loginResult = await this.login(password);
            if (!loginResult.success) {
              return {
                success: false,
                error: `Login failed: ${loginResult.error}`
              };
            }
          } else {
            return {
              success: false,
              error: `Account setup failed: ${accountResult.error}`
            };
          }
        }

        // Step 3: Create wallet
        operateLogger.info("Creating wallet");
        const walletResult = await this.createWallet(ledgerType);
        if (!walletResult.success) {
          return {
            success: false,
            error: `Wallet creation failed: ${walletResult.error}`
          };
        }

        // Step 4: Create Safe
        operateLogger.info("Creating Safe");
        const safeResult = await this.createSafe(chain, backupOwner);
        if (!safeResult.success) {
          return {
            success: false,
            error: `Safe creation failed: ${safeResult.error}`
          };
        }

        operateLogger.info({
          walletAddress: walletResult.wallet?.address,
          safeAddress: safeResult.safeAddress,
          chain
        }, "Wallet bootstrap completed successfully");

        // JINN-198: Keep server running for subsequent API calls
        // The caller is responsible for stopping the server when done
        return {
          success: true,
          walletAddress: walletResult.wallet?.address,
          safeAddress: safeResult.safeAddress,
          mnemonic: walletResult.wallet?.mnemonic
        };
      } catch (error) {
        // Only stop server on error
        this._stopServer();
        throw error;
      }
    } catch (error) {
      operateLogger.error({ error }, "Error during wallet bootstrap");
      // Ensure server is stopped on error
      this._stopServer();
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during bootstrap'
      };
    }
  }

  /**
   * Bootstrap wallet operations without Safe creation (for Tenderly funding)
   * @param config Bootstrap configuration
   */
  async bootstrapWalletWithoutSafe(config: {
    password: string;
    ledgerType?: string;
    chain: string;
  }): Promise<{
    success: boolean;
    walletAddress?: string;
    error?: string;
  }> {
    const { password, ledgerType = 'ethereum', chain } = config;

    try {
      // Step 0: Validate environment before starting
      operateLogger.info("Validating environment before bootstrap (without Safe)");
      const envValidation = await this.validateEnvironment();
      if (!envValidation.isValid) {
        return {
          success: false,
          error: `Environment validation failed: ${envValidation.issues.join(', ')}`
        };
      }

      // Step 1: Start server
      operateLogger.info("Starting operate server");
      const serverResult = await this._startServer();
      if (!serverResult.success) {
        return {
          success: false,
          error: `Failed to start server: ${serverResult.error}`
        };
      }

      // Step 2: Setup user account or login if account exists
      operateLogger.info("Setting up user account");
      const accountResult = await this.setupUserAccount(password);
      if (!accountResult.success) {
        // If account already exists, try to login instead
        if (accountResult.error?.includes('Account already exists')) {
          operateLogger.info("Account exists, attempting login");
          const loginResult = await this.login(password);
          if (!loginResult.success) {
            this._stopServer();
            return {
              success: false,
              error: `Login failed: ${loginResult.error}`
            };
          }
        } else {
          this._stopServer();
          return {
            success: false,
            error: `Account setup failed: ${accountResult.error}`
          };
        }
      }

      // Step 3: Create wallet (but no Safe yet)
      operateLogger.info("Creating wallet (without Safe)");
      const walletResult = await this.createWallet(ledgerType);
      if (!walletResult.success) {
        this._stopServer();
        return {
          success: false,
          error: `Wallet creation failed: ${walletResult.error}`
        };
      }

      operateLogger.info({
        walletAddress: walletResult.wallet?.address,
        chain
      }, "Wallet bootstrap completed successfully (without Safe)");

      // Don't stop server here - we need it running for Safe creation after funding
      return {
        success: true,
        walletAddress: walletResult.wallet?.address
      };
    } catch (error) {
      this._stopServer();
      operateLogger.error({ error }, "Bootstrap wallet without Safe failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Get the middleware installation path
   */
  getMiddlewarePath(): string {
    return this.middlewarePath;
  }

  /**
   * Public method to start the server
   */
  async startServer(): Promise<OperateResult> {
    const result = await this._startServer();
    if (result.success) {
      return { success: true };
    }
    return { success: false, error: result.error || 'Failed to start server' };
  }

  /**
   * Public method to stop the server (for cleanup)
   */
  async stopServer(): Promise<void> {
    if (this.isServerReady) {
      operateLogger.info({ serverPort: this.serverPort }, "Stopping server via public method");
      this._stopServer();
      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Check if the server is currently running
   */
  isServerRunning(): boolean {
    return this.isServerReady && this.serverProcess !== null && !this.serverProcess.killed;
  }

  /**
   * Get the server port (for wallet scripts that need the base URL)
   */
  getServerPort(): number {
    return this.serverPort;
  }

  /**
   * Terminate and withdraw a service (v2 API)
   * Used by wallet recovery scripts to unstake and get funds back
   */
  async terminateAndWithdraw(serviceConfigId: string, withdrawalAddress: string): Promise<OperateResult> {
    const result = await this.makeRequest(
      `/api/v2/service/${serviceConfigId}/terminate_and_withdraw`,
      'POST',
      { withdrawal_address: withdrawalAddress }
    );
    if (result.success) {
      operateLogger.info({ serviceConfigId, withdrawalAddress }, "Service terminated and withdrawal initiated");
      return { success: true };
    }
    operateLogger.error({ serviceConfigId, error: result.error }, "Terminate and withdraw failed");
    return { success: false, error: result.error || 'Terminate and withdraw failed' };
  }

  /**
   * Withdraw funds from wallet/safes to an external address
   * Used by wallet withdrawal scripts
   */
  async withdrawFunds(
    to: string,
    withdrawAssets: Record<string, Record<string, string>>
  ): Promise<{ success: boolean; transferTxs?: Record<string, Record<string, string[]>>; error?: string }> {
    const result = await this.makeRequest('/api/wallet/withdraw', 'POST', {
      password: this.password,
      to,
      withdraw_assets: withdrawAssets,
    });
    if (result.success) {
      operateLogger.info({ to }, "Withdrawal completed successfully");
      return { success: true, transferTxs: result.data?.transfer_txs };
    }
    operateLogger.error({ to, error: result.error }, "Withdrawal failed");
    return { success: false, error: result.error || 'Withdrawal failed' };
  }

  /**
   * Export wallet mnemonic/seed phrase
   * Used by wallet export scripts for recovery purposes
   */
  async exportMnemonic(ledgerType: string = 'ethereum'): Promise<{ success: boolean; mnemonic?: string[]; error?: string }> {
    const result = await this.makeRequest('/api/wallet/mnemonic', 'POST', {
      password: this.password,
      ledger_type: ledgerType,
    });
    if (result.success && result.data?.mnemonic) {
      operateLogger.info({ ledgerType }, "Mnemonic exported successfully");
      return { success: true, mnemonic: result.data.mnemonic };
    }
    operateLogger.error({ ledgerType, error: result.error }, "Mnemonic export failed");
    return { success: false, error: result.error || 'Mnemonic export failed' };
  }
}
