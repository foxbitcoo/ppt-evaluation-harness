declare const environmentOriginBrand: unique symbol;

export interface TestEnvironmentOrigin {
  readonly originId: "test:mock-bakeoff-v1";
  readonly environment: "test";
  readonly [environmentOriginBrand]: "test";
}

export interface ProductionEnvironmentOrigin {
  readonly originId: "production:ppt-evaluation-v1";
  readonly environment: "production";
  readonly [environmentOriginBrand]: "production";
}

export type EnvironmentOrigin =
  | TestEnvironmentOrigin
  | ProductionEnvironmentOrigin;

const testOrigins = new WeakSet<object>();
const productionOrigins = new WeakSet<object>();

function registeredOrigin<T extends EnvironmentOrigin>(
  origin: Omit<T, typeof environmentOriginBrand>,
  registry: WeakSet<object>,
): T {
  const frozen = Object.freeze(origin) as T;
  registry.add(frozen);
  return frozen;
}

export const MOCK_TEST_ENVIRONMENT_ORIGIN =
  registeredOrigin<TestEnvironmentOrigin>(
    {
      originId: "test:mock-bakeoff-v1",
      environment: "test",
    },
    testOrigins,
  );

export const PRODUCTION_ENVIRONMENT_ORIGIN =
  registeredOrigin<ProductionEnvironmentOrigin>(
    {
      originId: "production:ppt-evaluation-v1",
      environment: "production",
    },
    productionOrigins,
  );

export function assertEnvironmentOriginAllowed(
  origin: EnvironmentOrigin,
  targetEnvironment: "test" | "production",
  entityName: string,
): void {
  const registry =
    targetEnvironment === "production" ? productionOrigins : testOrigins;
  if (
    typeof origin !== "object" ||
    origin === null ||
    !registry.has(origin as object)
  ) {
    throw new Error(
      `${targetEnvironment} rejected ${entityName}: incompatible environment origin`,
    );
  }
}
