/**
 * dcs/db/client.ts — DbClient 抽象 + oracledb 连接池（方案 §2/§3）。
 *
 * - DbClient 为接口：冒烟测试注入假实现，不连真库即可全量回归；
 * - 真实实现：oracledb Thin 模式连接池（min 1 / max 2），惰性创建单例，
 *   每次 execute 设置 callTimeout=20s（防慢查询吃掉回复预算）；
 * - 环境变量门控：DCS_DB_USER / DCS_DB_PASSWORD / DCS_DB_CONNECT_STRING
 *   任一缺失 → 数据库能力不可用；
 * - 错误契约：execute 的 ORA 错误向上抛，由工具层捕获并转为文本返回
 *   （供模型自我修正 SQL），本模块不做吞错。
 */
import oracledb from "oracledb";

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated?: boolean;
  columnTypes?: Array<{ name: string; type: string; precision?: number; scale?: number; nullable?: boolean }>;
}

export type DbBinds = Record<string, string | number | null>;

export interface DbClient {
  execute(sql: string, binds?: DbBinds): Promise<DbQueryResult>;
  /** 分批读取完整查询；等待consume完成后才读取下一批。 */
  stream?(sql: string, binds: DbBinds, consume: (batch: DbQueryResult) => Promise<void>, signal?: AbortSignal): Promise<void>;
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

  async execute(sql: string, binds: DbBinds = {}): Promise<DbQueryResult> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      connection.callTimeout = SQL_CALL_TIMEOUT_MS;
      await connection.execute("SET TRANSACTION READ ONLY");
      const result = await connection.execute(sql, binds, {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        maxRows: 1001, // 多取一行，明确报告驱动侧截断
      });
      return {
        columns: (result.metaData ?? []).map((m) => m.name),
        rows: ((result.rows ?? []) as unknown[][]).slice(0, 1000),
        truncated: (result.rows?.length ?? 0) > 1000,
      };
    } finally {
      try { await connection.rollback(); } finally { await connection.close(); }
    }
  }

  async stream(sql: string, binds: DbBinds, consume: (batch: DbQueryResult) => Promise<void>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const connection = await (await this.getPool()).getConnection();
    let resultSet: oracledb.ResultSet<unknown[]> | undefined;
    let breaking: Promise<void> | undefined;
    const abort = () => { breaking ??= connection.break().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      connection.callTimeout = SQL_CALL_TIMEOUT_MS;
      await connection.execute("SET TRANSACTION READ ONLY");
      const result = await connection.execute<unknown[]>(sql, binds, {
        resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, fetchArraySize: 256,
        // NUMBER用十进制字符串保留金额/长ID精度；元数据仍记录Oracle类型。
        fetchTypeHandler: metadata => {
          if (metadata.dbType === oracledb.DB_TYPE_NUMBER || metadata.dbType === oracledb.DB_TYPE_CLOB || metadata.dbType === oracledb.DB_TYPE_NCLOB) return { type: oracledb.STRING };
          if (metadata.dbType === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER };
          return undefined;
        },
      });
      resultSet = result.resultSet;
      if (!resultSet) throw new Error("查询未返回结果集，请使用SELECT/WITH查询。");
      const columnTypes = (result.metaData ?? []).map(m => ({ name: m.name, type: m.dbTypeName ?? String(m.dbType),
        precision: m.precision, scale: m.scale, nullable: m.nullable }));
      const columns = columnTypes.map(m => m.name);
      while (true) {
        signal?.throwIfAborted();
        const rows = await resultSet.getRows(256);
        signal?.throwIfAborted();
        await consume({ columns, columnTypes, rows, truncated: false });
        if (!rows.length) break;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await breaking;
      try { await resultSet?.close(); }
      finally { try { await connection.rollback(); } finally { await connection.close(); } }
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
