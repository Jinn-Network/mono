// SPDX-License-Identifier: Apache-2.0

/**
 * Print-only environment checks.
 *
 * A `claude` session that captures nothing produces no failure, just silence — which is the
 * one thing an operator cannot debug. This is the surface that makes the silence legible, and
 * every failing check names one command that fixes it, or says the break is not fixable from
 * this machine.
 */

import { readPin, resolveSessionRuntime } from "./runtime.mjs";
import { modelIdentity } from "./identity.mjs";
import { pluginDir, runtimeHome, stateDir } from "./paths.mjs";

export function checks(env = process.env) {
  const results = [];

  const pin = readPin();
  results.push(
    pin === undefined
      ? {
          name: "runtime-pin",
          ok: false,
          detail: "runtime-pin.json is missing or malformed",
          remedy: null,
        }
      : {
          name: "runtime-pin",
          ok: true,
          detail: `${pin.package}@${pin.version}`,
          remedy: null,
        },
  );

  const resolution = resolveSessionRuntime(env);
  results.push(
    resolution === undefined
      ? {
          name: "runtime-available",
          ok: false,
          detail: "no session-role runtime resolved; this session captures nothing",
          remedy:
            pin === undefined
              ? null
              : `npm install --prefix "${pluginDir()}" ${pin.package}@${pin.version}`,
        }
      : {
          name: "runtime-available",
          ok: true,
          detail: `${resolution.detail} (${resolution.source})`,
          remedy: null,
        },
  );

  const model = modelIdentity(env);
  results.push({
    name: "model-identity",
    ok: model.service !== undefined,
    detail:
      model.service === undefined
        ? "the model is not knowable from this environment; the record will name no deployment"
        : model.service.iri,
    remedy: model.service === undefined ? "export ANTHROPIC_MODEL=<model>" : null,
  });

  results.push({
    name: "state",
    ok: true,
    detail: `${stateDir(env)} (runtime home ${runtimeHome(env)})`,
    remedy: null,
  });

  return results;
}

export function doctor(env = process.env) {
  return checks(env).flatMap((check) => {
    const line = `[${check.ok ? "ok  " : "fail"}] ${check.name}: ${check.detail}`;
    return check.ok || check.remedy === null ? [line] : [line, `         fix: ${check.remedy}`];
  });
}
