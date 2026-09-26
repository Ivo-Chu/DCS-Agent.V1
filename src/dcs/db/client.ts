/**
 * dcs/db/client.ts — DbClient 抽象 + oracledb 连接池（方案 §2/§3）。
 *
 * - DbClient 为接口：冒烟测试注入假实现，不连真库即可全量回归；
 * - 真实实现：oracledb Thin 模式连接池（min 1 / max 2），惰性创建单例，
 *   每次 execute 设置 callTimeout=20s（防慢查询吃掉回复预算）；
 * - 环境变量门控：DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING
 *   任一缺失 → 能力不可用（与 DCS_SOURCE_ROOT 模式一致）；
 * - 错误契约：execute 的 ORA 错误向上抛，由工具层捕获并转为文本返回
 *   （供模型自我修正 SQL），本模块不做吞错。
 */
import oracledb from "oracledb";

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface DbClient {
  execute(sql: string): Promise<DbQueryResult>;
  close(): Promise<void>;
}

/** 单条 SQL 执行超时（毫秒）。 */
export const SQL_CALL_TIMEOUT_MS = 20_000;

export function isDbConfigured(): boolean {
  return Boolean(
    process.env.DCS_DB_USER && process.env.DCS_DB_PASSWORD && process.env.DCS_DB_CONNECT_STRING
  );
}

// 注意：oracledb 6 默认即 Thin 模式（纯 JS，免装客户端）；
// 不调用 initOracleClient——那是切换 Thick 模式的开关，会要求本机客户端库。

class OracleDbClient implements DbClient {
  private pool: oracledb.Pool | null = null;

  private async getPool(): Promise<oracledb.Pool> {
    if (!this.pool) {
      this.pool = await oracledb.createPool({
        user: process.env.DCS_DB_USER,
        password: process.env.DCS_DB_PASSWORD,
        connectString: process.env.DCS_DB_CONNECT_STRING,
        poolMin: 1,
        poolMax: 2,
        poolIncrement: 1,
        enableStatistics: false,
      });
    }
    return this.pool;
  }

  async execute(sql: string): Promise<DbQueryResult> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      connection.callTimeout = SQL_CALL_TIMEOUT_MS;
      const result = await connection.execute(sql, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        maxRows: 1000, // format 层负责 100 行截断；此处仅防极端值
      });
      return {
        columns: (result.metaData ?? []).map((m) => m.name),
        rows: (result.rows ?? []) as unknown[][],
      };
    } finally {
      await connection.close();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.close(0);
    }
  }
}

type DbClientFactory = () => DbClient | null;

/** 默认工厂：环境变量齐全时返回真实 Oracle 客户端单例，否则 null。 */
const defaultFactory: DbClientFactory = (() => {
  let singleton: OracleDbClient | null = null;
  return () => {
    if (!isDbConfigured()) return null;
    if (!singleton) singleton = new OracleDbClient();
    return singleton;
  };
})();

let clientFactory: DbClientFactory = defaultFactory;

/** 测试注入：替换 DbClient 工厂（传 null 恢复默认）。 */
export function setDbClientFactoryForTest(factory: DbClientFactory | null): void {
  clientFactory = factory ?? defaultFactory;
}

/** 获取当前可用的 DbClient；未配置数据库时返回 null。 */
export function getDbClient(): DbClient | null {
  return clientFactory();
}

/** 进程退出时释放连接池（bot 入口注册）。 */
export async function closeDbClient(): Promise<void> {
  if (clientFactory === defaultFactory) {
    await defaultFactory()?.close();
  }
}
