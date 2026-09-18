-- 安运通 · 危货运输监管平台 数据库结构（MySQL 8.0, utf8mb4）
-- 演示数据由后端启动时注入（SEED_DEMO=true），本文件只负责结构。

CREATE TABLE IF NOT EXISTS enterprises (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(128) NOT NULL COMMENT '企业名称',
  code_prefix   VARCHAR(8)  NOT NULL COMMENT '运单号企业前缀',
  license_no    VARCHAR(64) NULL COMMENT '道路运输经营许可证号',
  contact_phone VARCHAR(32) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_enterprises_prefix (code_prefix)
) ENGINE=InnoDB COMMENT='危货运输企业';

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  name          VARCHAR(64) NOT NULL COMMENT '姓名',
  role          ENUM('ENTERPRISE_ADMIN','DRIVER','ESCORT','REGULATOR') NOT NULL COMMENT '企业管理员/驾驶员/押运员/监管员',
  enterprise_id BIGINT UNSIGNED NULL COMMENT '所属企业，监管员为 NULL',
  phone         VARCHAR(32) NULL,
  active        TINYINT NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_username (username),
  KEY idx_users_enterprise (enterprise_id),
  CONSTRAINT fk_users_enterprise FOREIGN KEY (enterprise_id) REFERENCES enterprises(id)
) ENGINE=InnoDB COMMENT='平台账号';

-- 单号计数器：按 企业+年份 单调递增，作废不复用
CREATE TABLE IF NOT EXISTS waybill_counters (
  enterprise_id BIGINT UNSIGNED NOT NULL,
  seq_year      INT NOT NULL,
  next_seq      INT NOT NULL DEFAULT 1,
  PRIMARY KEY (enterprise_id, seq_year),
  CONSTRAINT fk_counters_enterprise FOREIGN KEY (enterprise_id) REFERENCES enterprises(id)
) ENGINE=InnoDB COMMENT='运单号顺序号计数器（只增不减）';

CREATE TABLE IF NOT EXISTS waybills (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  waybill_no        VARCHAR(32) NOT NULL COMMENT '企业前缀+年份+顺序号',
  enterprise_id     BIGINT UNSIGNED NOT NULL,
  status            ENUM('DRAFT','ENTERPRISE_REVIEW','REGULATOR_VERIFY','DISPATCHED','IN_TRANSIT','COMPLETED','ABORTED')
                    NOT NULL DEFAULT 'DRAFT' COMMENT '填报/企业自审/监管核验/已派车/运输中/已完成/异常中止',
  cargo_name        VARCHAR(128) NOT NULL COMMENT '货物名称',
  cargo_class       VARCHAR(32)  NOT NULL COMMENT '危险货物类别',
  quantity          DECIMAL(10,2) NOT NULL,
  unit              VARCHAR(16)  NOT NULL DEFAULT '吨',
  origin            VARCHAR(255) NOT NULL COMMENT '装货地',
  destination       VARCHAR(255) NOT NULL COMMENT '卸货地',
  vehicle_plate     VARCHAR(16)  NOT NULL COMMENT '承运车辆号牌',
  driver_id         BIGINT UNSIGNED NOT NULL COMMENT '驾驶员（与押运员不得同一人）',
  escort_id         BIGINT UNSIGNED NOT NULL COMMENT '押运员',
  planned_departure DATETIME NOT NULL COMMENT '计划发车时间',
  planned_arrival   DATETIME NOT NULL COMMENT '计划到达时间',
  actual_departure  DATETIME NULL,
  actual_arrival    DATETIME NULL,
  abort_reason      VARCHAR(500) NULL COMMENT '异常中止/作废原因',
  remark            VARCHAR(500) NULL,
  idempotency_key   VARCHAR(64) NULL COMMENT '创建幂等键，防重复开单',
  created_by        BIGINT UNSIGNED NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_waybills_no (waybill_no),
  UNIQUE KEY uq_waybills_idem (idempotency_key),
  KEY idx_waybills_ent_status (enterprise_id, status),
  KEY idx_waybills_status (status),
  KEY idx_waybills_planned_dep (planned_departure),
  KEY idx_waybills_planned_arr (planned_arrival),
  KEY idx_waybills_driver (driver_id),
  KEY idx_waybills_escort (escort_id),
  CONSTRAINT fk_waybills_enterprise FOREIGN KEY (enterprise_id) REFERENCES enterprises(id),
  CONSTRAINT fk_waybills_driver FOREIGN KEY (driver_id) REFERENCES users(id),
  CONSTRAINT fk_waybills_escort FOREIGN KEY (escort_id) REFERENCES users(id)
) ENGINE=InnoDB COMMENT='电子运单';

-- 状态流转留痕：每一次变迁（含离线补录）都落一条事件
CREATE TABLE IF NOT EXISTS waybill_events (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  waybill_id         BIGINT UNSIGNED NOT NULL,
  seq                INT NOT NULL COMMENT '单内事件序号',
  action             VARCHAR(32) NOT NULL COMMENT 'create/submit/.../depart/arrive/abort',
  from_status        VARCHAR(32) NULL,
  to_status          VARCHAR(32) NOT NULL,
  actor_id           BIGINT UNSIGNED NULL,
  actor_name         VARCHAR(64) NULL,
  reason             VARCHAR(500) NULL,
  idempotency_key    VARCHAR(64) NULL COMMENT '离线/重试幂等键',
  client_occurred_at DATETIME NULL COMMENT '离线端实际发生时间（山区无网补录）',
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_events_idem (idempotency_key),
  UNIQUE KEY uq_events_waybill_seq (waybill_id, seq),
  CONSTRAINT fk_events_waybill FOREIGN KEY (waybill_id) REFERENCES waybills(id)
) ENGINE=InnoDB COMMENT='运单状态流转留痕';

-- 幂等键仓库：离线恢复重放、双击、网络重试都返回首次结果，不产生重复运单/重复事件
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idem_key      VARCHAR(64) PRIMARY KEY,
  user_id       BIGINT UNSIGNED NOT NULL,
  endpoint      VARCHAR(128) NOT NULL,
  waybill_id    BIGINT UNSIGNED NULL,
  http_status   INT NOT NULL,
  response_body JSON NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_idem_created (created_at)
) ENGINE=InnoDB COMMENT='写操作幂等键';
