/**
 * スコープマネージャー
 * Global / Agent / User レベルでメモリを分離
 */

export interface ScopeDefinition {
  description?: string;
}

export interface ScopeConfig {
  defaultScope: string;
  definitions: Record<string, ScopeDefinition>;
  agentAccess?: Record<string, string[]>;
}

export interface ScopeManager {
  resolve(agentId?: string, userScope?: string): string;
  isValid(scope: string): boolean;
  canAccess(agentId: string, scope: string): boolean;
  listScopes(): string[];
  defaultScope: string;
}

const BUILT_IN_SCOPES: Record<string, ScopeDefinition> = {
  global: { description: "全エージェント共有スコープ" },
  _system: { description: "システム内部用" },
};

/**
 * ScopeManager を生成
 */
export function createScopeManager(config?: Partial<ScopeConfig>): ScopeManager {
  const defaultScope = config?.defaultScope || "global";
  const definitions: Record<string, ScopeDefinition> = {
    ...BUILT_IN_SCOPES,
    ...(config?.definitions || {}),
  };
  const agentAccess: Record<string, string[]> | undefined = config?.agentAccess;

  return {
    defaultScope,

    resolve(agentId?: string, userScope?: string): string {
      // 明示的スコープが指定されていればそれを使う
      if (userScope && this.isValid(userScope)) return userScope;
      // エージェントIDがあればエージェント固有スコープ
      if (agentId) return `agent:${agentId}`;
      return defaultScope;
    },

    isValid(scope: string): boolean {
      // 定義済みスコープ、または動的プレフィックス (agent:, project:, user:)
      if (scope in definitions) return true;
      if (scope.startsWith("agent:") || scope.startsWith("project:") || scope.startsWith("user:")) {
        return true;
      }
      return false;
    },

    canAccess(agentId: string, scope: string): boolean {
      // agentAccess 未設定、または当該エージェントの制限が未定義なら全許可
      if (!agentAccess || !(agentId in agentAccess)) return true;
      const allowed = agentAccess[agentId];
      // ワイルドカード
      if (allowed.includes("*")) return true;
      return allowed.includes(scope);
    },

    listScopes(): string[] {
      return Object.keys(definitions);
    },
  };
}
