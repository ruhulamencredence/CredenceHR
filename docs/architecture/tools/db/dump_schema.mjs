// চালু MariaDB/MySQL-এর information_schema -> *.tsv (cwd-তে)। সার্ভারের মতোই DB_* env পড়ে।
import fs from "fs";
import mysql from "mysql2/promise";
const db = process.env.DB_NAME || "mpr_tracker_db";
const c = await mysql.createConnection({ host: process.env.DB_HOST || "localhost", user: process.env.DB_USER || "root", password: process.env.DB_PASSWORD || "", port: Number(process.env.DB_PORT) || 3306, database: db });
const Q = {
  "cols.tsv": "select table_name,column_name,column_type,is_nullable,column_key,ifnull(column_default,'NULL'),extra,ordinal_position from information_schema.columns where table_schema=? order by table_name,ordinal_position",
  "fks.tsv": "select table_name,column_name,referenced_table_name,referenced_column_name,constraint_name from information_schema.key_column_usage where table_schema=? and referenced_table_name is not null order by 1,2",
  "tabs.tsv": "select table_name,table_rows,ifnull(table_comment,'') from information_schema.tables where table_schema=? and table_type='BASE TABLE'",
  "idx.tsv": "select table_name,index_name,non_unique,group_concat(column_name order by seq_in_index) from information_schema.statistics where table_schema=? group by table_name,index_name,non_unique",
  "rules.tsv": "select delete_rule,count(*) from information_schema.referential_constraints where constraint_schema=? group by 1",
};
for (const [f, q] of Object.entries(Q)) {
  const [rows] = await c.query({ sql: q, rowsAsArray: true }, [db]);
  fs.writeFileSync(f, rows.map(r => r.map(v => String(v ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n") + "\n");
  console.log(f, rows.length);
}
await c.end();
