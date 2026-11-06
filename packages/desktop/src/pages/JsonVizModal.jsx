import {
  App,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme,
} from "antd";
import {
  ArrowLeftOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  ClearOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  HolderOutlined,
  PlusOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SaveOutlined,
  SearchOutlined,
  SwapOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import "./JsonVizModal.css";

const { Text } = Typography;

/** 只读上下文：左右对照时左侧「原始内容」整棵树都只读，无需逐层传参。 */
const ReadOnlyCtx = createContext(false);

/** 方块左侧强调色（按 section 顺序轮换）。 */
const PALETTE = [
  "#1677ff",
  "#13c2c2",
  "#52c41a",
  "#fa8c16",
  "#eb2f96",
  "#722ed1",
  "#a0d911",
  "#f5222d",
];

/** 把任意值序列化为稳定字符串用于比较（对象按 key 排序）。 */
function stableStringify(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, (k, v) =>
      typeof v === "object" && v !== null && !Array.isArray(v)
        ? Object.keys(v)
            .sort()
            .reduce((o, key) => ((o[key] = v[key]), o), {})
        : v,
    );
  } catch {
    return String(value);
  }
}

/** 比较两个值是否相等。 */
function equal(a, b) {
  return stableStringify(a) === stableStringify(b);
}

// 宽松解析：兼容带 /* */ 注释头 / BOM / 尾逗号的 JSON（Shopify 模板文件、版本快照）
function parseJsonText(text) {
  if (typeof text !== "string") return text;
  let s = text.replace(/^\uFEFF/, "").trim();
  // 只剥掉文件开头的块注释（Shopify 自动生成的说明头），不碰字符串内的内容
  const m = s.match(/^\/\*[\s\S]*?\*\//);
  if (m) s = s.slice(m[0].length).trim();
  return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1"));
}

/** path 或其子路径是否有改动。 */
function changedUnder(changed, path) {
  if (!changed) return false;
  if (changed.has(path)) return true;
  for (const p of changed) {
    if (path && p.startsWith(path + ".")) return true;
  }
  return false;
}

/** 在嵌套对象/数组的 path 处设置新值，返回新对象（不可变更新）。 */
function setAtPath(obj, path, value) {
  const keys = path.split(".");
  const root = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const child = cur[k];
    cur[k] = Array.isArray(child) ? [...child] : { ...child };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return root;
}

/** 对比 saved 与 current，返回变化的路径集合。 */
function diffPaths(saved, current, prefix = "") {
  const changed = new Set();
  if (equal(saved, current)) return changed;
  if (
    saved === null ||
    current === null ||
    typeof saved !== "object" ||
    typeof current !== "object"
  ) {
    if (prefix) changed.add(prefix);
    return changed;
  }
  const keys = new Set([
    ...(Array.isArray(saved) ? saved.map((_, i) => i) : Object.keys(saved || {})),
    ...(Array.isArray(current)
      ? current.map((_, i) => i)
      : Object.keys(current || {})),
  ]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : String(k);
    const sv = saved?.[k];
    const cv = current?.[k];
    if (!equal(sv, cv)) {
      if (sv && cv && typeof sv === "object" && typeof cv === "object") {
        const sub = diffPaths(sv, cv, p);
        if (sub.size === 0) changed.add(p);
        else sub.forEach((x) => changed.add(x));
      } else {
        changed.add(p);
      }
    }
  }
  return changed;
}

/* ---------------- 数组编辑器：序号 + 拖拽排序 + 增删改 ---------------- */
function ArrayEditor({ path, value, onChange }) {
  const dragFrom = useRef(null);
  const [dragOver, setDragOver] = useState(null);
  const [newVal, setNewVal] = useState("");

  const commit = (arr) => onChange(path, arr);

  const moveItem = (from, to) => {
    if (from == null || to == null || from === to) return;
    const arr = [...value];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    commit(arr);
  };

  const setItem = (i, v) => {
    const arr = [...value];
    // 保持原类型（数字数组不要被改成字符串）
    arr[i] = typeof value[i] === "number" ? (v === "" ? "" : Number(v)) : v;
    commit(arr);
  };

  const removeItem = (i) => commit(value.filter((_, idx) => idx !== i));

  const addItem = () => {
    commit([...value, newVal.trim()]);
    setNewVal("");
  };

  return (
    <div className="jv-array">
      {value.map((item, i) => (
        <div
          key={i}
          className={`jv-array-item${dragOver === i ? " jv-drop-target" : ""}`}
          draggable
          onDragStart={(e) => {
            // 从输入框里拖拽时不要触发排序（避免影响选中文字）
            if (e.target.tagName === "INPUT") {
              e.preventDefault();
              return;
            }
            dragFrom.current = i;
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (dragOver !== i) setDragOver(i);
          }}
          onDragLeave={() => setDragOver((cur) => (cur === i ? null : cur))}
          onDrop={(e) => {
            e.preventDefault();
            moveItem(dragFrom.current, i);
            dragFrom.current = null;
            setDragOver(null);
          }}
          onDragEnd={() => {
            dragFrom.current = null;
            setDragOver(null);
          }}
        >
          <span className="jv-drag" title="拖拽排序">
            <HolderOutlined />
          </span>
          <span className="jv-index">{i + 1}</span>
          {typeof item === "object" ? (
            <span className="jv-chip" style={{ flex: 1 }}>
              {JSON.stringify(item)}
            </span>
          ) : (
            <Input
              size="small"
              value={item}
              onChange={(e) => setItem(i, e.target.value)}
            />
          )}
          <Tooltip title="删除">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeItem(i)}
            />
          </Tooltip>
        </div>
      ))}
      <div className="jv-array-add">
        <Input
          size="small"
          placeholder="新增一项后回车或点击 +"
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          onPressEnter={addItem}
        />
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          onClick={addItem}
        >
          添加
        </Button>
      </div>
    </div>
  );
}

/* ---------------- 只读值展示（左侧原始内容，样式与右侧一致但不可编辑） ---------------- */
function StaticValue({ value }) {
  if (value === null || value === undefined) {
    return <Input size="small" value="null" readOnly className="jv-readonly-value" />;
  }
  if (Array.isArray(value)) {
    return (
      <div className="jv-array">
        {value.length === 0 && <span className="jv-mono">[]</span>}
        {value.map((v, i) => (
          <div key={i} className="jv-array-item">
            {/* 占位：与右侧拖拽手柄/删除按钮等宽，保证左右列对齐 */}
            <span className="jv-drag jv-placeholder">
              <HolderOutlined />
            </span>
            <span className="jv-index">{i + 1}</span>
            <Input
              size="small"
              readOnly
              className="jv-readonly-value"
              value={typeof v === "object" ? JSON.stringify(v) : String(v)}
            />
            <span className="jv-op-space" />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <Select
        size="small"
        value={value}
        open={false}
        style={{ width: "100%" }}
        options={[
          { value: true, label: "true" },
          { value: false, label: "false" },
        ]}
      />
    );
  }
  if (typeof value === "object") {
    return (
      <Input
        size="small"
        readOnly
        className="jv-readonly-value"
        value={JSON.stringify(value)}
      />
    );
  }
  return (
    <Input
      size="small"
      readOnly
      className="jv-readonly-value"
      value={String(value)}
    />
  );
}

/* ---------------- 值控件 ---------------- */
function ValueControl({ path, value, onChange }) {
  const readOnly = useContext(ReadOnlyCtx);
  if (readOnly) return <StaticValue value={value} />;
  if (typeof value === "boolean") {
    return (
      <Select
        size="small"
        value={value}
        onChange={(v) => onChange(path, v)}
        options={[
          { value: true, label: "true" },
          { value: false, label: "false" },
        ]}
      />
    );
  }
  if (typeof value === "number") {
    return (
      <Input
        size="small"
        type="number"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(path, v === "" ? "" : Number(v));
        }}
      />
    );
  }
  if (value === null) {
    return <span className="jv-mono">null</span>;
  }
  if (Array.isArray(value)) {
    return <ArrayEditor path={path} value={value} onChange={onChange} />;
  }
  return (
    <Input
      size="small"
      value={value}
      onChange={(e) => onChange(path, e.target.value)}
    />
  );
}

/* ---------------- 单行属性 ---------------- */
function PropRow({ path, name, value, meta, changed, onChange, filter }) {
  const info = meta?.[path];
  const label = info?.label;
  const isChanged = changed?.has(path);
  const hasLabel = !!label && label !== name;
  const isArray = Array.isArray(value);
  // 搜索过滤：label / 字段 id / 值 命中才显示（空关键词全显示）
  if (filter) {
    const f = filter.toLowerCase();
    const hit =
      (label && label.toLowerCase().includes(f)) ||
      name.toLowerCase().includes(f) ||
      (typeof value === "string" || typeof value === "number") &&
        String(value).toLowerCase().includes(f);
    if (!hit) return null;
  }
  return (
    <div
      className={`jv-row${isArray ? " jv-row-array" : ""}${isChanged ? " jv-changed" : ""}`}
    >
      <div className="jv-row-label">
        {hasLabel ? (
          <>
            <span className="jv-label" title={label}>
              {label}
            </span>
            <span className="jv-key">{name}</span>
          </>
        ) : (
          <span className="jv-key jv-key-solo">{name}</span>
        )}
        {info?.type && <span className="jv-type">{info.type}</span>}
      </div>
      <div className="jv-row-value">
        <ValueControl path={path} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

/* ---------------- 属性列表（settings 等） ---------------- */
function PropsList({ obj, basePath, meta, changed, onChange, depth = 0, filter }) {
  const keys = Object.keys(obj || {});
  if (keys.length === 0) return <div className="jv-empty">无设置项</div>;
  // 搜索过滤：有 filter 时先算出命中的 key；全没命中且自己也匹配不上才空
  const f = filter ? filter.toLowerCase() : "";
  const visible = keys.filter((k) => {
    if (!f) return true;
    const path = basePath ? `${basePath}.${k}` : k;
    const v = obj[k];
    const info = meta?.[path];
    if (info?.label && info.label.toLowerCase().includes(f)) return true;
    if (k.toLowerCase().includes(f)) return true;
    if (
      (typeof v === "string" || typeof v === "number") &&
      String(v).toLowerCase().includes(f)
    )
      return true;
    // 嵌套对象：看子级有没有命中（走一遍递归判断）
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return hasDeepMatch(v, f, meta, path, 0);
    }
    return false;
  });
  if (f && visible.length === 0) return null;
  return (
    <>
      {visible.map((k) => {
        const path = basePath ? `${basePath}.${k}` : k;
        const v = obj[k];
        const isPlainObj = v && typeof v === "object" && !Array.isArray(v);
        if (isPlainObj && depth < 2) {
          return (
            <div
              key={path}
              className={`jv-nested${changedUnder(changed, path) ? " jv-changed" : ""}`}
            >
              <div className="jv-nested-head">
                <span className="jv-label">{meta?.[path]?.label || k}</span>
                <span className="jv-key">{k}</span>
              </div>
              <PropsList
                obj={v}
                basePath={path}
                meta={meta}
                changed={changed}
                onChange={onChange}
                depth={depth + 1}
                filter={filter}
              />
            </div>
          );
        }
        return (
          <PropRow
            key={path}
            path={path}
            name={k}
            value={v}
            meta={meta}
            changed={changed}
            onChange={onChange}
            filter={filter}
          />
        );
      })}
    </>
  );
}

/** 搜索辅助：嵌套对象任意子级的 label/id/值 是否命中关键词。 */
function hasDeepMatch(obj, f, meta, basePath, depth) {
  for (const k of Object.keys(obj || {})) {
    const path = basePath ? `${basePath}.${k}` : k;
    const v = obj[k];
    const info = meta?.[path];
    if (info?.label && info.label.toLowerCase().includes(f)) return true;
    if (k.toLowerCase().includes(f)) return true;
    if (
      (typeof v === "string" || typeof v === "number") &&
      String(v).toLowerCase().includes(f)
    )
      return true;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 6) {
      if (hasDeepMatch(v, f, meta, path, depth + 1)) return true;
    }
  }
  return false;
}

/* ---------------- block 子方块 ---------------- */
function BlockCard({ id, block, basePath, meta, changed, onChange, onMove, onDelete, ghost, filter }) {
  const readOnly = ghost || useContext(ReadOnlyCtx); // 幽灵卡片（对侧已删除）强制只读
  const [dragOver, setDragOver] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // 折叠：只留头部
  const canDrag = !readOnly && !ghost && !!onMove;
  const canDelete = !readOnly && !ghost && !!onDelete;
  const info = meta?.[basePath];
  const settings =
    block?.settings && typeof block.settings === "object" ? block.settings : {};
  const extras = Object.keys(block || {}).filter(
    (k) => k !== "type" && k !== "settings",
  );
  const blockLabel = info?.label;
  const isAppBlock =
    typeof block?.type === "string" &&
    (block.type.startsWith("@") || block.type.startsWith("shopify:"));
  // 搜索过滤：区块的 label / id / type / 子级配置命中才显示
  if (filter) {
    const f = filter.toLowerCase();
    const hit =
      (blockLabel && blockLabel.toLowerCase().includes(f)) ||
      id.toLowerCase().includes(f) ||
      (typeof block?.type === "string" && block.type.toLowerCase().includes(f)) ||
      hasDeepMatch(settings, f, meta, `${basePath}.settings`, 0) ||
      extras.some((k) => k.toLowerCase().includes(f) ||
        ((typeof block[k] === "string" || typeof block[k] === "number") &&
          String(block[k]).toLowerCase().includes(f)));
    if (!hit) return null;
  }
  return (
    <div
      className={`jv-block${ghost ? " jv-ghost" : ""}${collapsed ? " jv-collapsed" : ""}${changedUnder(changed, basePath) ? " jv-block-changed" : ""}${
        dragOver && canDrag ? " jv-drop-target" : ""
      }`}
      onDragOver={
        canDrag
          ? (e) => {
              if (!e.dataTransfer.types.includes("jv-block")) return;
              e.preventDefault();
              e.stopPropagation();
              if (!dragOver) setDragOver(true);
            }
          : undefined
      }
      onDragLeave={canDrag ? () => setDragOver(false) : undefined}
      onDrop={
        canDrag
          ? (e) => {
              if (!e.dataTransfer.types.includes("jv-block")) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOver(false);
              const fromId = e.dataTransfer.getData("jv-block");
              if (fromId && fromId !== id) onMove(fromId, id);
            }
          : undefined
      }
    >
      <div
        className="jv-block-head"
        draggable={canDrag}
        onDragStart={
          canDrag
            ? (e) => {
                if (e.target.tagName === "INPUT") {
                  e.preventDefault();
                  return;
                }
                e.stopPropagation();
                e.dataTransfer.setData("jv-block", id);
                e.dataTransfer.effectAllowed = "move";
              }
            : undefined
        }
      >
        {canDrag && (
          <span className="jv-drag" title="拖拽调整区块顺序">
            <HolderOutlined />
          </span>
        )}
        <span
          className={`jv-fold${collapsed ? " jv-fold-closed" : ""}`}
          title={collapsed ? "展开" : "折叠"}
          onClick={() => setCollapsed((c) => !c)}
        >
          <DownOutlined />
        </span>
        <span
          className="jv-title"
          title={blockLabel || id}
          onClick={() => setCollapsed((c) => !c)}
        >
          {blockLabel || id}
        </span>
        {blockLabel && <span className="jv-mono">{id}</span>}
        {!blockLabel && isAppBlock && block?.type && (
          <span className="jv-type">{block.type}</span>
        )}
        {!blockLabel && !isAppBlock && (
          <span className="jv-badge">无配置说明</span>
        )}
        <span className="jv-spacer" />
        {canDelete && (
          <Tooltip title="删除该区块">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={onDelete}
            />
          </Tooltip>
        )}
      </div>
      {!collapsed && (
        <div className="jv-block-body">
          {Object.keys(settings).length > 0 ? (
            <PropsList
              obj={settings}
              basePath={`${basePath}.settings`}
              meta={meta}
              changed={changed}
              onChange={onChange}
              filter={filter}
            />
          ) : (
            <div className="jv-empty">
              {isAppBlock ? "该区块由 App 提供，本地没有可配置项" : "无设置项"}
            </div>
          )}
          {extras.map((k) => (
            <PropRow
              key={k}
              path={`${basePath}.${k}`}
              name={k}
              value={block[k]}
              meta={meta}
              changed={changed}
              onChange={onChange}
              filter={filter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- section 父方块 ---------------- */
function SectionCard({
  id,
  section,
  basePath,
  meta,
  changed,
  onChange,
  index,
  configLabel,
  onMoveSection,
  onDeleteSection,
  repoDir,
  defaultEditor,
  ghost,
  ghostBlocks,
  filter,
}) {
  const { message } = App.useApp();
  const readOnly = ghost || useContext(ReadOnlyCtx); // 幽灵卡片（对侧已删除）强制只读
  const [dragOver, setDragOver] = useState(false);
  const [collapsed, setCollapsed] = useState(false); // 折叠：只留头部，配置/区块隐藏
  const info = meta?.[basePath];
  const color = PALETTE[index % PALETTE.length];
  const canDrag = !readOnly && !ghost && !!onMoveSection;
  const canDelete = !readOnly && !ghost && !!onDeleteSection;
  const settings =
    section?.settings && typeof section.settings === "object"
      ? section.settings
      : {};
  const blocks =
    section?.blocks && typeof section.blocks === "object" ? section.blocks : {};
  const blockOrder = Array.isArray(section?.block_order)
    ? section.block_order
    : null;
  const extras = Object.keys(section || {}).filter(
    (k) => !["type", "settings", "blocks", "block_order"].includes(k),
  );
  // 优先按 block_order 排序，其余按原始顺序补充
  const blockIds = [
    ...(blockOrder || []).filter((bid) => blocks[bid]),
    ...Object.keys(blocks).filter(
      (bid) => !(blockOrder || []).includes(bid),
    ),
  ];
  // 对侧有、本侧没有的区块（幽灵卡片 + 大叉）
  const ghostBlockIds = ghostBlocks
    ? Object.keys(ghostBlocks).filter((gid) => !blocks[gid])
    : [];

  // 拖拽 = 直接改 block_order，界面不再单独展示该数组
  const moveBlock = (fromId, toId) => {
    const list = [...blockIds];
    const from = list.indexOf(fromId);
    const to = list.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    onChange(`${basePath}.block_order`, list);
  };

  const deleteBlock = (bid) => {
    const nextBlocks = { ...blocks };
    delete nextBlocks[bid];
    onChange(`${basePath}.blocks`, nextBlocks);
    if (Array.isArray(blockOrder)) {
      onChange(
        `${basePath}.block_order`,
        blockOrder.filter((x) => x !== bid),
      );
    }
  };

  // 新增区块：从 section schema 里定义的 block 类型中选择（下拉），按类型定义生成配置项结构
  const [blockTypes, setBlockTypes] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  // 新增（未保存）区块的本地含义覆盖层：保存后磁盘 meta 会覆盖同一批路径，此处只做过渡显示
  const [extraMeta, setExtraMeta] = useState({});
  const mergedMeta = useMemo(() => ({ ...meta, ...extraMeta }), [meta, extraMeta]);

  // 搜索过滤：section 的 label / id / type / 自身配置 / 任意区块内命中才显示
  //（放在所有 hooks 之后，避免条件 return 造成 hooks 数量变化白屏）
  if (filter) {
    const f = filter.toLowerCase();
    const selfHit =
      (info?.label && info.label.toLowerCase().includes(f)) ||
      id.toLowerCase().includes(f) ||
      (typeof section?.type === "string" && section.type.toLowerCase().includes(f)) ||
      hasDeepMatch(settings, f, meta, `${basePath}.settings`, 0) ||
      extras.some(
        (k) =>
          k.toLowerCase().includes(f) ||
          ((typeof section[k] === "string" || typeof section[k] === "number") &&
            String(section[k]).toLowerCase().includes(f)),
      );
    const blocksHit =
      blockIds.some(
        (bid) =>
          bid.toLowerCase().includes(f) ||
          (meta?.[`${basePath}.blocks.${bid}`]?.label || "")
            .toLowerCase()
            .includes(f) ||
          hasDeepMatch(
            blocks[bid]?.settings || {},
            f,
            meta,
            `${basePath}.blocks.${bid}.settings`,
            0,
          ),
      ) || ghostBlockIds.some((gid) => gid.toLowerCase().includes(f));
    if (!selfHit && !blocksHit) return null;
  }
  const openAddBlock = () => {
    if (blockTypes.length > 0) {
      setAddOpen(true);
      return;
    }
    if (!section?.type || !repoDir) return;
    window.api.repos
      .jsonVizBlockTypes({ dir: repoDir, sectionType: section.type })
      .then((res) => {
        const list = res.ok ? res.data?.types || [] : [];
        setBlockTypes(list);
        setAddOpen(list.length > 0);
        if (list.length === 0) message.warning("该 section 的 schema 未定义可选区块类型");
      });
  };
  const addBlock = (bt) => {
    const newId = `${bt.type}_${Date.now().toString(36)}`;
    onChange(`${basePath}.blocks`, {
      ...blocks,
      [newId]: { type: bt.type, settings: { ...(bt.settingsTemplate || {}) } },
    });
    if (Array.isArray(blockOrder)) {
      onChange(`${basePath}.block_order`, [...blockOrder, newId]);
    }
    // 把该类型的 name / 字段含义挂到本地覆盖层，让新区块和已有区块显示一致（label + id + 类型）
    const overlay = {
      [`${basePath}.blocks.${newId}`]: { label: bt.name, type: bt.type },
    };
    for (const s of bt.settings || []) {
      if (!s?.id) continue;
      overlay[`${basePath}.blocks.${newId}.settings.${s.id}`] = {
        label: s.label,
        type: s.type,
      };
    }
    setExtraMeta((cur) => ({ ...cur, ...overlay }));
    setAddOpen(false);
  };

  return (
    <div
      className={`jv-card${ghost ? " jv-ghost" : ""}${collapsed ? " jv-collapsed" : ""}${changedUnder(changed, basePath) ? " jv-card-changed" : ""}${
        dragOver && canDrag ? " jv-drop-target" : ""
      }`}
      onDragOver={
        canDrag
          ? (e) => {
              if (!e.dataTransfer.types.includes("jv-section")) return;
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }
          : undefined
      }
      onDragLeave={canDrag ? () => setDragOver(false) : undefined}
      onDrop={
        canDrag
          ? (e) => {
              e.preventDefault();
              setDragOver(false);
              const fromId = e.dataTransfer.getData("jv-section");
              if (fromId && fromId !== id) onMoveSection(fromId, id);
            }
          : undefined
      }
    >
      <div
        className="jv-card-head"
        draggable={canDrag}
        onDragStart={
          canDrag
            ? (e) => {
                e.dataTransfer.setData("jv-section", id);
                e.dataTransfer.effectAllowed = "move";
              }
            : undefined
        }
      >
        {canDrag && (
          <span className="jv-drag" title="拖拽调整区块顺序">
            <HolderOutlined />
          </span>
        )}
        <span
          className={`jv-fold${collapsed ? " jv-fold-closed" : ""}`}
          title={collapsed ? "展开" : "折叠"}
          onClick={() => setCollapsed((c) => !c)}
        >
          <DownOutlined />
        </span>
        <span className="jv-accent" style={{ background: color }} />
        <span
          className="jv-title"
          title={configLabel || info?.label || id}
          onClick={() => setCollapsed((c) => !c)}
        >
          {configLabel || info?.label || id}
        </span>
        <span className="jv-mono">{id}</span>
        <span className="jv-spacer" />
        {!collapsed && !readOnly && section?.type && repoDir && (
          <Tooltip title={`在编辑器中打开 sections/${section.type}.liquid`}>
            <Button
              type="text"
              size="small"
              icon={<FileTextOutlined />}
              onClick={() =>
                window.api.repos
                  .openInEditor({
                    dir: repoDir,
                    editorId: defaultEditor || undefined,
                    file: `sections/${section.type}.liquid`,
                  })
                  .then((r) => {
                    if (!r.ok) message.error(r.error || "打开失败");
                  })
              }
            />
          </Tooltip>
        )}
        {section?.type && (
          <Tag color="blue" bordered={false} style={{ margin: 0 }}>
            {section.type}
          </Tag>
        )}
        {blockIds.length > 0 && <span className="jv-badge">{blockIds.length} 个区块</span>}
        {!readOnly && !!onDeleteSection && (
          <Tooltip title="删除该 section（同时从 order 移除）">
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={onDeleteSection}
            />
          </Tooltip>
        )}
      </div>

      {!collapsed && (
        <div className="jv-body">
          {Object.keys(settings).length > 0 ? (
            <PropsList
              obj={settings}
              basePath={`${basePath}.settings`}
              meta={mergedMeta}
              changed={changed}
              onChange={onChange}
              filter={filter}
            />
          ) : (
            <div className="jv-empty">无设置项</div>
          )}

        {extras.map((k) => (
          <PropRow
            key={k}
            path={`${basePath}.${k}`}
            name={k}
            value={section[k]}
            meta={mergedMeta}
            changed={changed}
            onChange={onChange}
            filter={filter}
          />
        ))}

          <div className="jv-sub">
            区块 · {blockIds.length}
            {!readOnly && (
              addOpen ? (
                <Select
                  size="small"
                  autoFocus
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择要添加的区块类型"
                  style={{ minWidth: 220 }}
                  options={blockTypes.map((bt) => ({
                    value: bt.type,
                    label: bt.name === bt.type ? bt.type : `${bt.name}（${bt.type}）`,
                  }))}
                  onSelect={(_, opt) =>
                    addBlock(blockTypes.find((bt) => bt.type === opt.value))
                  }
                  onBlur={() => setAddOpen(false)}
                  notFoundContent="无可选类型"
                />
              ) : (
                <Tooltip title="从 section schema 定义的区块类型中选择新增">
                  <Button
                    type="dashed"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={openAddBlock}
                  >
                    添加区块
                  </Button>
                </Tooltip>
              )
            )}
          </div>
          <div className="jv-blocks-grid">
            {blockIds.map((bid) => (
              <BlockCard
                key={bid}
                id={bid}
                block={blocks[bid]}
                basePath={`${basePath}.blocks.${bid}`}
                meta={mergedMeta}
                changed={changed}
                onChange={onChange}
                onMove={moveBlock}
                onDelete={() => deleteBlock(bid)}
                filter={filter}
              />
            ))}
            {/* 对侧已删除的区块：幽灵卡片 + 大叉覆盖（只读展示，不可交互） */}
            {ghostBlockIds.map((gid) => (
              <BlockCard
                key={`__ghost_${gid}`}
                id={gid}
                block={ghostBlocks[gid]}
                basePath={`__ghost__.${gid}`}
                meta={meta}
                changed={null}
                onChange={() => {}}
                ghost
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 模板 JSON（templates/*.json） ---------------- */
/**
 * 对比栏：side = "orig"（旧·蓝灰）/ "mod"（新·橙），整栏染色，滚动到任何位置都能分辨左右。
 * head：图标块 + 主标题 + 副标题（mono 小字）+ 差异数 chip。
 */
function DiffPane({ side, icon, title, sub, count, bodyRef, onScroll, children }) {
  return (
    <section className={`jv-pane jv-pane-${side}`}>
      <div className="jv-pane-head">
        <span className="jv-pane-icon">{icon}</span>
        <span className="jv-pane-titles">
          <span className="jv-pane-title">{title}</span>
          {sub && <span className="jv-pane-sub">{sub}</span>}
        </span>
        {count > 0 && (
          <span className={`jv-pane-count jv-pane-count-${side}`}>
            {count} 处差异
          </span>
        )}
      </div>
      <div className="jv-pane-body" ref={bodyRef} onScroll={onScroll}>
        {children}
      </div>
    </section>
  );
}

/** 对比栏中间的方向指示（避免两栏贴在一起分不清阅读方向）。 */
function DiffArrow({ label }) {
  return (
    <div className="jv-diff-arrow">
      <SwapOutlined />
      {label && <span>{label}</span>}
    </div>
  );
}

function TemplateView({ data, meta, changed, onChange, onReplace, repoPath, defaultEditor, ghostParts, filter }) {
  const sections =
    data?.sections && typeof data.sections === "object" ? data.sections : {};
  const order = Array.isArray(data?.order) ? data.order : [];
  const ids = [
    ...order.filter((id) => sections[id]),
    ...Object.keys(sections).filter((id) => !order.includes(id)),
  ];
  // 对侧有、本侧没有的 section：以「幽灵卡片 + 大叉」展示删除标记
  const ghostSections = ghostParts?.sections || null;
  const ghostIds = ghostSections
    ? Object.keys(ghostSections).filter((gid) => !sections[gid])
    : [];
  const extraKeys = Object.keys(data || {}).filter(
    (k) => k !== "sections" && k !== "order" && k !== "name",
  );

  // 拖拽 section 卡片 = 直接改 order，界面不再单独展示 order 数组
  const moveSection = (fromId, toId) => {
    const list = [...ids];
    const from = list.indexOf(fromId);
    const to = list.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    onChange("order", list);
  };

  const deleteSection = (sid) => {
    const next = { ...data, sections: { ...sections } };
    delete next.sections[sid];
    if (Array.isArray(data.order)) {
      next.order = data.order.filter((x) => x !== sid);
    }
    onReplace(next);
  };

  return (
    <div className="jv-wrap">
      {(data?.name || extraKeys.length > 0) && (
        <div className="jv-topbar">
          {data?.name && (
            <>
              <span className="jv-badge">模板</span>
              <span className="jv-title">{data.name}</span>
            </>
          )}
          {extraKeys.map((k) => (
            <PropRow
              key={k}
              path={k}
              name={k}
              value={data[k]}
              meta={meta}
              changed={changed}
              onChange={onChange}
            />
          ))}
        </div>
      )}

      {ids.map((id, i) => (
        <SectionCard
          key={id}
          id={id}
          section={sections[id]}
          basePath={`sections.${id}`}
          meta={meta}
          changed={changed}
          onChange={onChange}
          index={i}
          repoDir={repoPath}
          defaultEditor={defaultEditor}
          onMoveSection={moveSection}
          onDeleteSection={() => deleteSection(id)}
          ghostBlocks={ghostParts?.blocks?.[id]}
          filter={filter}
        />
      ))}

      {/* 对侧已删除的 section：幽灵卡片 + 大叉覆盖（只读展示，不可交互） */}
      {ghostIds.map((gid) => (
        <SectionCard
          key={`__ghost_${gid}`}
          id={gid}
          section={ghostSections[gid]}
          basePath={`__ghost__.${gid}`}
          meta={meta}
          changed={null}
          onChange={() => {}}
          index={0}
          ghost
        />
      ))}

      {ids.length === 0 && ghostIds.length === 0 && (
        <div className="jv-empty">该模板没有 sections</div>
      )}
    </div>
  );
}

/* ---------------- 全局配置 JSON（config/settings_data.json） ---------------- */
function ConfigGroupCard({ label, obj, basePath, meta, changed, onChange, index }) {
  const sections =
    obj?.sections && typeof obj.sections === "object" ? obj.sections : {};
  const settingKeys = Object.keys(obj || {}).filter((k) => k !== "sections");
  const settings = {};
  for (const k of settingKeys) settings[k] = obj[k];
  const ids = Object.keys(sections);

  return (
    <div className="jv-card">
      <div className="jv-card-head">
        <span
          className="jv-accent"
          style={{ background: PALETTE[index % PALETTE.length] }}
        />
        <span className="jv-title">{label}</span>
        <span className="jv-mono">{basePath}</span>
        <span className="jv-spacer" />
        {ids.length > 0 && <span className="jv-badge">{ids.length} 个区块</span>}
      </div>
      <div className="jv-body">
        {settingKeys.length > 0 ? (
          <PropsList
            obj={settings}
            basePath={basePath}
            meta={meta}
            changed={changed}
            onChange={onChange}
          />
        ) : (
          <div className="jv-empty">无全局设置项</div>
        )}
        {ids.length > 0 && (
          <>
            <div className="jv-sub">区块 · {ids.length}</div>
            {ids.map((sid, i) => (
              <SectionCard
                key={sid}
                id={sid}
                section={sections[sid]}
                basePath={`${basePath}.sections.${sid}`}
                meta={meta}
                changed={changed}
                onChange={onChange}
                index={index + i + 1}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SettingsDataView({ data, meta, changed, onChange }) {
  const groups = [];
  if (data?.current && typeof data.current === "object") {
    groups.push({
      key: "current",
      label: "当前配置 · Current",
      obj: data.current,
      basePath: "current",
    });
  }
  for (const [pname, p] of Object.entries(data?.presets || {})) {
    if (!p || typeof p !== "object") continue;
    groups.push({
      key: `presets.${pname}`,
      label: `预设 · ${pname}`,
      obj: p,
      basePath: `presets.${pname}`,
    });
  }

  return (
    <div className="jv-wrap">
      {groups.map((g, i) => (
        <ConfigGroupCard
          key={g.key}
          label={g.label}
          obj={g.obj}
          basePath={g.basePath}
          meta={meta}
          changed={changed}
          onChange={onChange}
          index={i}
        />
      ))}
      {groups.length === 0 && <div className="jv-empty">没有可展示的配置</div>}
    </div>
  );
}

/* ---------------- 通用兜底视图 ---------------- */
function GenericView({ data, meta, changed, onChange }) {
  if (data === null || typeof data !== "object") {
    return <div className="jv-empty">该 JSON 顶层不是对象或数组</div>;
  }
  return (
    <div className="jv-wrap">
      <div className="jv-card">
        <div className="jv-card-head">
          <span className="jv-accent" style={{ background: "#1677ff" }} />
          <span className="jv-title">JSON 内容</span>
          <span className="jv-spacer" />
          <span className="jv-badge">
            {Array.isArray(data) ? `${data.length} 项` : `${Object.keys(data).length} 个键`}
          </span>
        </div>
        <div className="jv-body">
          {Array.isArray(data) ? (
            <ValueControl path="" value={data} onChange={onChange} />
          ) : (
            <PropsList
              obj={data}
              basePath=""
              meta={meta}
              changed={changed}
              onChange={onChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 主页面（整页视图，非弹窗） ---------------- */
export default function JsonVizPage({ open, repo, defaultFileName, onClose }) {
  const { message } = App.useApp();
  const [defaultEditor, setDefaultEditor] = useState(null);

  // 读全局设置里的默认编辑器，供 section 头部「在编辑器中打开」使用
  useEffect(() => {
    if (!open) return;
    window.api.settings.get().then((res) => {
      const s = res?.ok ? res.data : res;
      setDefaultEditor(s?.defaultEditor || null);
    });
  }, [open]);

  const { modal } = App.useApp();
  const { token } = theme.useToken();
  const [files, setFiles] = useState([]); // [{ rel, path }]
  const [search, setSearch] = useState("");
  const [current, setCurrent] = useState(null); // { rel, path }
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState({});
  const [savedData, setSavedData] = useState(null); // 上次保存/加载的磁盘数据
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [activeVersionId, setActiveVersionId] = useState(null); // 当前内容对应的版本 id
  const [pendingVersion, setPendingVersion] = useState(null); // 已选中待确认切换的版本 { id, label, data }
  const [pendingSave, setPendingSave] = useState(false); // 点了「保存」进入保存前对比预览态
  const [externalChanged, setExternalChanged] = useState(false); // 文件在外部被修改
  const [externalVersion, setExternalVersion] = useState(null); // 外部新内容，待用户决定是否采用
  const [recentList, setRecentList] = useState([]); // 近期改动记录 [{ repoDir, repoName, rel, path, ts, label }]
  const [filter, setFilter] = useState(""); // 内容搜索：按配置 label / 字段 id / 值过滤
  // ref 同步：watcher 回调里 state 是旧闭包值，去重判断要用最新值
  const externalVersionRef = useRef(null);
  externalVersionRef.current = externalVersion;

  // 左右对照时同步滚动：按滚动比例对齐，内容高度不同也能上下一起动。
  // 回声抑制：程序设置 scrollTop 后浏览器会异步派发对面的 scroll 事件，
  // 记录「刚设置过的元素+值」，事件位置与之完全相等即判定为回声直接忽略；
  // 不用锁 + rAF（跟随侧每帧晚一拍，体感延迟）。
  const leftPaneRef = useRef(null);
  const rightPaneRef = useRef(null);
  const lastSetScroll = useRef(null); // { el, value }
  // 保存写盘会同时触发单文件 watch 和仓库级 watch，用它屏蔽自己写的
  const selfWriteUntil = useRef(0);
  const syncScroll = (srcRef, dstRef) => (e) => {
    const src = e.target;
    const last = lastSetScroll.current;
    // 自己刚被程序滚到这里 → 这是程序滚动引发的回声事件，忽略
    if (last && last.el === src && last.value === src.scrollTop) return;
    const dst = dstRef.current;
    if (!dst || dst === src) return;
    const maxSrc = Math.max(1, src.scrollHeight - src.clientHeight);
    const target = Math.round(
      (src.scrollTop / maxSrc) * Math.max(0, dst.scrollHeight - dst.clientHeight),
    );
    if (dst.scrollTop === target) return;
    lastSetScroll.current = { el: dst, value: target };
    dst.scrollTop = target; // 同步赋值，跟随侧当帧到位，无延迟
  };

  const repoPath = repo?.path;

  // 每次打开（或切换仓库）都从干净状态开始，避免带上一个文件/仓库的残留
  useEffect(() => {
    if (!open) return;
    setCurrent(null);
    setData(null);
    setSavedData(null);
    setMeta({});
    setVersions([]);
    setSearch("");
    setFilter("");
    // 近期改动列表只在打开文件列表页时拉取（本仓库优先展示）
    window.api.repos.jsonVizListRecent().then((res) => {
      setRecentList(res.ok ? res.data || [] : []);
    });
  }, [open, repoPath]);

  // 打开时列出文件；若有 defaultFileName 直接打开
  useEffect(() => {
    if (!open || !repoPath) return;
    window.api.repos.jsonVizList(repoPath).then((res) => {
      if (res.ok) {
        setFiles(res.data || []);
        if (defaultFileName) {
          const hit = res.data.find(
            (f) => f.rel === defaultFileName || f.rel.endsWith(defaultFileName),
          );
          if (hit) openFile(hit);
        }
      }
    });
    return () => {
      // 关闭时取消监听
      if (current) window.api.repos.jsonVizUnwatch(current.path);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoPath]);

  // 监听文件外部变化（专用单文件监听）
  useEffect(() => {
    if (!open) return;
    const off = window.api.repos.onJsonFileChanged(({ path }) => {
      if (current && path === current.path) {
        reloadFromDisk(false);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);

  // 兜底：仓库级 templates/config 监听也会推 repoUpdated（单文件 watch 在原子保存时可能漏）
  useEffect(() => {
    if (!open) return;
    const off = window.api.repos.onUpdated(({ repo }) => {
      if (repo?.path === repoPath && current) {
        reloadFromDisk(true);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repoPath, current]);

  // 记录近期改动：任何「文件内容真正落盘/被采用」的动作都调用
  const recordRecent = (file) => {
    if (!file || !repoPath) return;
    const parts = file.rel.split("/");
    window.api.repos.jsonVizAddRecent({
      repoDir: repoPath,
      repoName: repo?.name || parts[0],
      rel: file.rel,
      path: file.path,
    }).catch(() => {});
  };

  const openFile = async (file) => {
    setLoading(true);
    // 切换文件前取消上一个监听
    if (current) await window.api.repos.jsonVizUnwatch(current.path);
    const res = await window.api.repos.jsonVizRead({
      dir: repoPath,
      path: file.path,
    });
    setLoading(false);
    if (!res.ok) {
      message.error(res.error || "读取失败");
      return;
    }
    setCurrent(file);
    setData(res.data);
    setMeta(res.meta || {});
    setSavedData(res.data);
    setExternalChanged(false);
    setExternalVersion(null);
    setPendingVersion(null);
    setPendingSave(false);
    setFilter(""); // 新文件从干净状态开始，避免上个文件的搜索词残留
    // 监听该文件变化
    window.api.repos.jsonVizWatch(file.path);
    // 加载版本列表；若一个版本都没有，自动把当前磁盘内容记为初始版本
    const vres = await window.api.repos.jsonVizVersions({
      dir: repoPath,
      path: file.path,
    });
    const list = vres.ok ? vres.data || [] : [];
    if (list.length === 0 && res.raw != null) {
      const init = await window.api.repos.jsonVizSaveVersion({
        dir: repoPath,
        path: file.path,
        content: res.raw,
      });
      if (init.ok) {
        init.data.label += "（初始）";
        list.unshift(init.data);
      }
    }
    setVersions(list);
    // 「当前版本」按磁盘真实内容校准（主进程比对快照），匹配不到才退回最新
    setActiveVersionId(vres.matchedId || list[0]?.id || null);
  };

  const loadVersions = async (file) => {
    const res = await window.api.repos.jsonVizVersions({
      dir: repoPath,
      path: file.path,
    });
    if (res.ok) {
      setVersions(res.data || []);
      if (res.matchedId) setActiveVersionId(res.matchedId);
    }
  };

  const reloadFromDisk = async (silent = true) => {
    if (!current) return;
    // 自己刚保存触发的写盘事件：直接忽略（refs 里已是最新状态）
    if (Date.now() < selfWriteUntil.current) return;
    // 已在「外部改动待裁决」态且磁盘内容没变 → 同一次外部保存触发了多个
    // watcher（单文件 watch + 仓库级兜底），直接跳过，避免重复提示
    const pendingExt = externalVersionRef.current;
    if (pendingExt && pendingExt.path === current.path) {
      const again = await window.api.repos.jsonVizRead({
        dir: repoPath,
        path: current.path,
      });
      if (again.ok && equal(again.data, pendingExt.data)) {
        return;
      }
    }
    const res = await window.api.repos.jsonVizRead({
      dir: repoPath,
      path: current.path,
    });
    if (!res.ok) return;
    const diskData = res.data;
    // 磁盘内容与已保存态一致 → 无外部变化
    if (equal(diskData, savedRef.current)) {
      setExternalChanged(false);
      setExternalVersion(null);
      return;
    }
    // 磁盘内容恰好等于当前编辑态 → 是自己刚写的（state 尚未落库），静默同步
    if (equal(diskData, dataRef.current)) {
      setSavedData(diskData);
      setExternalChanged(false);
      setExternalVersion(null);
      return;
    }
    // 外部被修改：绝不自动覆盖当前显示内容，挂起外部新内容，进入「外部改动对比」态由用户决定
    const pending = { path: current.path, data: diskData, meta: res.meta || {} };
    // 同步写 ref：两个 watcher 几乎同时触发时，第二个能在第一个 setState 渲染前就看到挂起态
    externalVersionRef.current = pending;
    setExternalChanged(true);
    setExternalVersion(pending);
    if (!silent) message.warning("文件已在外部被修改，请对比后选择采用或忽略");
  };

  // 采用外部新内容：外部内容成为当前版本基准（本地已有改动会被覆盖，需确认）
  const adoptExternalVersion = () => {
    if (!externalVersion) return;
    const apply = () => {
      selfWriteUntil.current = Date.now() + 2000;
      window.api.repos
        .jsonVizWrite({ path: current.path, value: externalVersion.data })
        .then((wres) => {
          if (!wres.ok) {
            message.error(wres.error || "写入失败");
            return;
          }
          setData(externalVersion.data);
          setSavedData(externalVersion.data);
          setMeta(externalVersion.meta);
          setExternalChanged(false);
          setExternalVersion(null);
          recordRecent(current);
          loadVersions(current);
          message.success("已采用外部修改，本地文件已同步");
        });
    };
    // 当前有未保存编辑时，采用外部内容会丢掉编辑，需二次确认
    if (dirtyRef.current) {
      modal.confirm({
        title: "采用外部修改将覆盖您的编辑",
        content:
          "您有未保存的修改，采用外部内容后这些修改将丢失（不会存入任何版本）。可先点「存为新版本」保留编辑。",
        okText: "放弃编辑并采用",
        okButtonProps: { danger: true },
        cancelText: "返回保存",
        onOk: apply,
      });
    } else {
      apply();
    }
  };

  // 忽略外部修改：本地文件回写为当前版本内容（文件跟着版本走），外部内容另存为快照供以后找回
  const ignoreExternalVersion = async () => {
    if (!externalVersion) return;
    setSaving(true);
    try {
      // 1) 磁盘回写为当前版本内容，保证「忽略后文件 = 当前版本」
      selfWriteUntil.current = Date.now() + 2000;
      const wres = await window.api.repos.jsonVizWrite({
        path: current.path,
        value: data,
      });
      if (!wres.ok) {
        message.error(wres.error || "回写失败，磁盘仍是外部内容");
        return;
      }
      setSavedData(data);
      // 2) 外部内容存为一条版本快照，以后想找回随时从版本列表切
      try {
        const raw = JSON.stringify(externalVersion.data, null, 2);
        const vres = await window.api.repos.jsonVizSaveVersion({
          dir: repoPath,
          path: current.path,
          content: raw,
        });
        if (vres.ok) {
          await loadVersions(current);
          recordRecent(current);
          message.success(
            `已忽略外部修改，本地文件已恢复为当前版本（外部内容已存为版本 ${vres.data.label}）`,
          );
        } else {
          message.success("已忽略外部修改，本地文件已恢复为当前版本");
        }
      } catch {
        message.success("已忽略外部修改，本地文件已恢复为当前版本");
      }
      setExternalChanged(false);
      setExternalVersion(null);
    } finally {
      setSaving(false);
    }
  };

  // 放弃当前编辑，从磁盘重新加载
  const discardAndReload = async () => {
    if (!current) return;
    const res = await window.api.repos.jsonVizRead({
      dir: repoPath,
      path: current.path,
    });
    if (!res.ok) {
      message.error(res.error || "读取失败");
      return;
    }
    selfWriteUntil.current = Date.now() + 2000;
    await window.api.repos.jsonVizWrite({
      path: current.path,
      value: savedRef.current,
    });
    setData(savedRef.current);
    setMeta(res.meta || {});
    setExternalChanged(false);
    setExternalVersion(null);
    message.success("已重新加载");
  };

  const dirty = !equal(data, savedData);
  // 当前显示数据与已保存数据之间的差异路径集合（驱动橙色高亮）
  const changedPaths = useMemo(
    () => (dirty ? diffPaths(savedData, data) : new Set()),
    [dirty, savedData, data],
  );

  // 用 ref 同步最新值：文件监听回调里拿到的 state 是闭包里的旧值，
  // 保存写盘触发 watcher 时 savedData 还没来得及更新，会误判成「外部修改」
  const dataRef = useRef(data);
  const savedRef = useRef(savedData);
  const dirtyRef = useRef(dirty);
  dataRef.current = data;
  savedRef.current = savedData;
  dirtyRef.current = dirty;

  // 放弃未保存改动：回到已保存版本的内容（二次确认，防止误点丢失编辑）
  const onDiscardChanges = () => {
    modal.confirm({
      title: "放弃未保存的修改？",
      content: "页面将恢复到当前版本的内容，您的所有编辑将丢失，且不会存入任何版本。",
      okText: "放弃修改",
      okButtonProps: { danger: true },
      cancelText: "继续编辑",
      onOk: () => {
        setData(savedData);
        setExternalChanged(false);
        setPendingSave(false);
        message.info("已放弃修改，恢复到当前版本");
      },
    });
  };

  const onChange = (path, value) => {
    setData((d) => setAtPath(d, path, value));
  };

  // 保存：写盘 + 存版本
  const onSave = async (versionName) => {
    if (!current || saving || !dirty) return;
    // 标记「即将自查写盘」：写盘会触发文件监听，窗口期内忽略外部变化事件，
    // 避免单文件 watch + 仓库级 watch 各触发一次导致保存流程被打断两次
    selfWriteUntil.current = Date.now() + 2000;
    setSaving(true);
    try {
      const wres = await window.api.repos.jsonVizWrite({
        path: current.path,
        value: data,
      });
      if (!wres.ok) {
        message.error(wres.error || "写入失败");
        return;
      }
      // 记录版本（存当前 data，即新版本内容；名称来自保存前的弹窗输入，可留空）
      const vres = await window.api.repos.jsonVizSaveVersion({
        dir: repoPath,
        path: current.path,
        content: JSON.stringify(data, null, 2),
        name: versionName || undefined,
      });
      if (vres.ok) {
        setSavedData(data);
        setActiveVersionId(vres.data.id); // 指针移到刚存的新版本
        setExternalChanged(false);
        setPendingSave(false);
        recordRecent(current);
        const shown = versionName?.trim()
          ? `${versionName.trim()}（${vres.data.label}）`
          : vres.data.label;
        message.success(`已保存并记录版本 ${shown}`);
        loadVersions(current);
      } else {
        message.warning(`已写盘，但版本记录失败：${vres.error}`);
        setSavedData(data);
        setExternalChanged(false);
      }
    } finally {
      setSaving(false);
    }
  };

  // 点「保存」：先弹窗让用户给这个历史版本起名（可留空，留空则显示时间戳），
  // 确认后才写盘 + 记录版本
  const onSaveClick = () => {
    if (!current || saving || !dirty) return;
    let inputVal = "";
    modal.confirm({
      title: "保存为新版本",
      icon: null,
      content: (
        <div>
          <div style={{ marginBottom: 8, fontSize: 12, opacity: 0.65 }}>
            给这个历史版本起个名字，方便以后在版本列表里辨认（可留空）
          </div>
          <Input
            placeholder="例如：首页改版-加banner"
            onChange={(e) => (inputVal = e.target.value)}
            autoFocus
          />
        </div>
      ),
      okText: "保存",
      cancelText: "取消",
      onOk: () => onSave(inputVal),
    });
  };

  // 选中版本 → 不弹窗，进入「左右对比」预览态：
  // 左 = 当前内容，右 = 目标版本，右上角按钮从「保存」变为「切换」
  const onSwitchVersion = async (versionId) => {
    if (versionId === activeVersionId && !pendingVersion) return; // 已是该版本
    const version = versions.find((v) => v.id === versionId);
    if (!version) return;
    const vres = await window.api.repos.jsonVizLoadVersion({
      dir: repoPath,
      path: current.path,
      id: version.id,
    });
    if (!vres.ok) {
      message.error(vres.error || "加载版本失败");
      return;
    }
    let target;
    try {
      target = parseJsonText(vres.data);
    } catch {
      message.error("版本内容不是合法 JSON");
      return;
    }
    // 有未保存改动时，切换会丢掉改动，必须先确认
    if (dirtyRef.current) {
      modal.confirm({
        title: "当前有未保存的修改",
        content: "切换版本将放弃这些修改（未保存的改动不会存入任何版本）。建议先点「保存」存为新版本再切换。",
        okText: "放弃修改并切换",
        okButtonProps: { danger: true },
        cancelText: "返回保存",
        onOk: () => setPendingVersion({ id: version.id, label: version.label, data: target }),
      });
      return;
    }
    setPendingVersion({ id: version.id, label: version.label, data: target });
  };

  // 取消切换预览，回到正常编辑态
  const cancelPendingVersion = () => setPendingVersion(null);

  // ---- 历史版本管理：重命名 / 删除（作用于下拉里当前高亮选中的那个版本） ----
  const manageTarget = pendingVersion || versions.find((v) => v.id === activeVersionId) || null;

  const onRenameVersion = () => {
    if (!manageTarget || !current) return;
    let inputVal = manageTarget.name || "";
    modal.confirm({
      title: "重命名版本",
      icon: null,
      content: (
        <Input
          defaultValue={inputVal}
          placeholder="输入自定义名称，留空恢复为时间戳"
          onChange={(e) => (inputVal = e.target.value)}
          autoFocus
        />
      ),
      okText: "保存",
      cancelText: "取消",
      onOk: async () => {
        const res = await window.api.repos.jsonVizRenameVersion({
          dir: repoPath,
          path: current.path,
          id: manageTarget.id,
          name: inputVal,
        });
        if (!res.ok) {
          message.error(res.error || "重命名失败");
          return;
        }
        const list = await window.api.repos.jsonVizVersions({
          dir: repoPath,
          path: current.path,
        });
        if (list.ok) setVersions(list.data);
        if (pendingVersion) {
          setPendingVersion((cur) => ({ ...cur, label: res.data.label }));
        }
      },
    });
  };

  const onDeleteVersion = () => {
    if (!manageTarget || !current) return;
    modal.confirm({
      title: "删除该历史版本？",
      content: `「${manageTarget.label}」将被永久删除，不可恢复（当前版本不受影响）。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        const res = await window.api.repos.jsonVizDeleteVersion({
          dir: repoPath,
          path: current.path,
          id: manageTarget.id,
        });
        if (!res.ok) {
          message.error(res.error || "删除失败");
          return;
        }
        const list = await window.api.repos.jsonVizVersions({
          dir: repoPath,
          path: current.path,
        });
        if (list.ok) {
          setVersions(list.data);
          // 被删的是切换预览目标时，退出预览态
          if (pendingVersion && pendingVersion.id === manageTarget.id) {
            setPendingVersion(null);
          }
        }
        message.success("版本已删除");
      },
    });
  };

  // 批量删除版本：弹窗里勾选要删除的版本（当前版本除外），确认后一次性删除
  const [batchDelOpen, setBatchDelOpen] = useState(false);
  const [batchDelIds, setBatchDelIds] = useState(new Set());

  const openBatchDelete = () => {
    if (!current || versions.length === 0) return;
    // 默认全选除当前版本外的所有版本
    setBatchDelIds(
      new Set(versions.filter((v) => v.id !== activeVersionId).map((v) => v.id)),
    );
    setBatchDelOpen(true);
  };

  const onBatchDelete = async () => {
    const ids = [...batchDelIds];
    if (ids.length === 0) {
      message.warning("请先勾选要删除的版本");
      return;
    }
    const res = await window.api.repos.jsonVizDeleteVersion({
      dir: repoPath,
      path: current.path,
      ids,
    });
    if (!res.ok) {
      message.error(res.error || "批量删除失败");
      return;
    }
    setBatchDelOpen(false);
    const list = await window.api.repos.jsonVizVersions({
      dir: repoPath,
      path: current.path,
    });
    if (list.ok) {
      setVersions(list.data);
      // 被删的里有切换预览目标时，退出预览态
      if (pendingVersion && ids.includes(pendingVersion.id)) {
        setPendingVersion(null);
      }
    }
    message.success(`已删除 ${ids.length} 个版本，剩余 ${res.data.left} 个`);
  };

  // 确认切换：用目标版本写盘，当前版本指针指向它
  const confirmSwitchVersion = async () => {
    if (!pendingVersion) return;
    setSaving(true);
    try {
      // 标记「即将自查写盘」，避免文件监听误判为外部修改
      selfWriteUntil.current = Date.now() + 2000;
      const wres = await window.api.repos.jsonVizWrite({
        path: current.path,
        value: pendingVersion.data,
      });
      if (!wres.ok) {
        message.error(wres.error || "写入失败");
        return;
      }
      setData(pendingVersion.data);
      setSavedData(pendingVersion.data);
      setActiveVersionId(pendingVersion.id);
      setPendingVersion(null);
      setExternalChanged(false);
      recordRecent(current);
      message.success(`已切换到版本 ${pendingVersion.label}，本地文件已同步`);
    } finally {
      setSaving(false);
    }
  };

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.rel.toLowerCase().includes(q));
  }, [files, search]);

  // 对比时：mod 侧相对 base 侧缺失的部分（被删除的 section / 区块），用于幽灵卡片 + 大叉展示。
  // 幽灵卡片始终渲染在「缺少它的一侧」（切换目标 / 修改后），表示「采用后将消失」。
  const missingParts = (mod, base) => {
    const out = { sections: null, blocks: {} };
    const mSec = mod?.sections;
    const bSec = base?.sections;
    if (bSec && typeof bSec === "object") {
      for (const id of Object.keys(bSec)) {
        if (!mSec || typeof mSec !== "object" || !mSec[id]) {
          (out.sections ||= {})[id] = bSec[id];
        }
      }
    }
    if (mSec && bSec) {
      // 两侧都在的 section 内部：对侧有、本侧没有的区块
      for (const id of Object.keys(mSec)) {
        if (!bSec[id]) continue;
        const mBlocks = mSec[id]?.blocks;
        const bBlocks = bSec[id]?.blocks;
        if (!bBlocks || typeof bBlocks !== "object") continue;
        for (const bid of Object.keys(bBlocks)) {
          if (!mBlocks || typeof mBlocks !== "object" || !mBlocks[bid]) {
            (out.blocks[id] ||= {})[bid] = bBlocks[bid];
          }
        }
      }
    }
    return out.sections || Object.keys(out.blocks).length ? out : null;
  };

  // 差异数按「用户操作数」合并：删/增/排序 block 会同时改动 blocks.<id> 和
  // block_order（数组递归后是 block_order.<index>）两处 JSON 路径，
  // 同一 section 内这两类合并算 1 处，避免「只删了一个 block 却显示 2 处差异」。
  const mergeDiffCount = (paths) => {
    const set = new Set(paths);
    for (const p of set) {
      if (typeof p !== "string") continue;
      const m = p.match(/^(.*)\.block_order(?:\.\d+)?$/); // sections.<id>.block_order[.N]
      if (!m) continue;
      const sec = m[1];
      for (const q of set) {
        if (q.startsWith(sec + ".blocks")) {
          set.delete(p); // blocks 变更已覆盖，block_order 不单独计数
          break;
        }
      }
    }
    return set.size;
  };

  // 按数据形态选择视图：模板 / 全局配置 / 兜底。
  // 同一份渲染逻辑用于「修改后」（可编辑）与「原始」（只读，外层包 ReadOnlyCtx）。
  const renderView = (viewData, viewChanged, ghostParts, viewFilter) => {
    if (!viewData || typeof viewData !== "object") {
      return <div className="jv-empty">无可展示内容</div>;
    }
    if (viewData.sections && typeof viewData.sections === "object") {
      return (
        <TemplateView
          data={viewData}
          meta={meta}
          changed={viewChanged}
          onChange={onChange}
          onReplace={setData}
          repoPath={repoPath}
          defaultEditor={defaultEditor}
          ghostParts={ghostParts}
          filter={viewFilter}
        />
      );
    }
    if (viewData.current || viewData.presets) {
      return (
        <SettingsDataView
          data={viewData}
          meta={meta}
          changed={viewChanged}
          onChange={onChange}
        />
      );
    }
    return (
      <GenericView
        data={viewData}
        meta={meta}
        changed={viewChanged}
        onChange={onChange}
      />
    );
  };

  const jvThemeVars = {
    "--jv-border": token.colorBorderSecondary,
    "--jv-card-bg": token.colorBgContainer,
    "--jv-head-bg": token.colorFillQuaternary,
    "--jv-scroll-bg": token.colorBgLayout,
    "--jv-text": token.colorText,
    "--jv-muted": token.colorTextTertiary,
    "--jv-row-hover": token.colorFillQuaternary,
    "--jv-nested-bg": token.colorFillQuaternary,
    "--jv-block-bg": token.colorFillQuaternary,
    "--jv-block-accent": "#d46b08",
    "--jv-chip-bg": token.colorFillSecondary,
    "--jv-badge-bg": token.colorFillSecondary,
  };

  // 返回：文件已打开时回到文件列表；在文件列表时退出整页
  const goBack = () => {
    if (current) {
      window.api.repos.jsonVizUnwatch(current.path);
      setCurrent(null);
      setData(null);
      setSavedData(null);
      setVersions([]);
      return;
    }
    onClose();
  };

  // 整页视图：关闭时不渲染
  if (!open) return null;

  return (
    <div className="jv-page" style={jvThemeVars}>
      <header className="jv-page-head">
        <Tooltip title={current ? "返回文件列表" : "退出可视化"}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={goBack} />
        </Tooltip>
        <span className="jv-page-title">JSON 可视化</span>
        {repo?.name && (
          <Tag color="geekblue" style={{ margin: 0 }}>
            {repo.name}
          </Tag>
        )}
        {current && repoPath && (
          <Tooltip title={`在编辑器中打开 ${current.rel}`}>
            <Button
              type="text"
              size="small"
              icon={<FileTextOutlined />}
              onClick={() =>
                window.api.repos
                  .openInEditor({
                    dir: repoPath,
                    editorId: defaultEditor || undefined,
                    file: current.rel,
                  })
                  .then((r) => {
                    if (!r.ok) message.error(r.error || "打开失败");
                  })
              }
            />
          </Tooltip>
        )}
        {current && (
          <Tag color="cyan" style={{ margin: 0 }}>
            {current.rel}
          </Tag>
        )}
        <span className="jv-spacer" />
      </header>
      <div className="jv-page-body">
      {!current ? (
        <div style={jvThemeVars}>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索 JSON 文件名（如 product、index、settings_data）"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 12 }}
            allowClear
          />
          {/* 近期改动：只展示当前仓库的记录（跨仓库记录不显示，避免切换项目后混淆） */}
          {recentList.some((it) => it.repoDir === repoPath) && (
            <div className="jv-recent">
              <div className="jv-recent-head">
                <HistoryOutlined className="jv-recent-title-icon" />
                <span className="jv-recent-title">近期改动</span>
                <span className="jv-spacer" />
                <Button
                  size="small"
                  type="text"
                  danger
                  onClick={() => {
                    modal.confirm({
                      title: "清空全部近期改动记录？",
                      content: "仅清除记录，不影响文件内容和版本快照。",
                      okText: "清空",
                      okButtonProps: { danger: true },
                      cancelText: "取消",
                      onOk: async () => {
                        await window.api.repos.jsonVizClearRecent();
                        setRecentList([]);
                      },
                    });
                  }}
                >
                  全部清空
                </Button>
              </div>
              <div className="jv-recent-list">
                {recentList
                  .filter((it) => it.repoDir === repoPath)
                  .map((it) => {
                    return (
                      <div
                        key={`${it.repoDir}::${it.rel}`}
                        className="jv-recent-item"
                        title={`打开 ${it.rel}`}
                        onClick={() => {
                          const hit = files.find((f) => f.rel === it.rel);
                          if (hit) openFile(hit);
                          else message.warning("文件不存在，可能已被删除");
                        }}
                      >
                        <FileTextOutlined className="jv-recent-icon" />
                        <div className="jv-recent-main">
                          <span className="jv-recent-name">{it.rel.split("/").pop()}</span>
                          <span className="jv-recent-meta">{it.rel}</span>
                        </div>
                        <span className="jv-recent-time">{it.label}</span>
                        <Button
                          size="small"
                          type="text"
                          className="jv-recent-del"
                          icon={<CloseOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            window.api.repos
                              .jsonVizRemoveRecent({ repoDir: it.repoDir, rel: it.rel })
                              .then((res) => {
                                if (res.ok) setRecentList(res.data || []);
                              });
                          }}
                        />
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
          {files.length === 0 ? (
            <Empty description="该主题下未找到 JSON 文件" />
          ) : (
            <div className="jv-filelist">
              {filteredFiles.map((f) => {
                const parts = f.rel.split("/");
                const dir = parts.slice(0, -1).join("/");
                const name = parts[parts.length - 1];
                return (
                  <div key={f.rel} className="jv-file" onClick={() => openFile(f)}>
                    {f.rel.startsWith("templates/") ? (
                      <FileTextOutlined className="jv-file-icon" />
                    ) : (
                      <FolderOpenOutlined className="jv-file-icon" />
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="jv-file-name" title={name}>
                        {name}
                      </div>
                      <div className="jv-file-dir">{dir}</div>
                    </div>
                  </div>
                );
              })}
              {filteredFiles.length === 0 && (
                <Empty
                  description="没有匹配的文件"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={jvThemeVars}>
          {/* 右上角操作栏：搜索 / 重新加载 / 版本下拉 / 保存 */}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <Input
              size="small"
              allowClear
              placeholder="搜索配置（label / id / 值）"
              prefix={<SearchOutlined style={{ color: "var(--jv-muted)" }} />}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 220 }}
            />
            {current && versions.length > 0 && (
              <span className="jv-badge">{versions.length} 个历史版本</span>
            )}
            <Tooltip title="从磁盘重新加载">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => reloadFromDisk(true)}
              />
            </Tooltip>
            <Select
              size="small"
              style={{ minWidth: 230 }}
              value={
                pendingVersion
                  ? pendingVersion.id
                  : activeVersionId || undefined
              }
              onChange={onSwitchVersion}
              options={versions.map((v) => {
                // 「✓ 当前」只标真正生效的 activeVersionId；
                // pendingVersion 仅表示切换预览目标，不能抢走当前标签
                const tags = [];
                if (v.id === activeVersionId) tags.push("当前");
                if (pendingVersion && v.id === pendingVersion.id) tags.push("切换目标");
                const prefix = tags.length ? `✓ ${tags.join(" · ")} · ` : "";
                return { value: v.id, label: `${prefix}${v.label}` };
              })}
              notFoundContent="暂无历史版本"
              suffixIcon={<HistoryOutlined />}
              listHeight={220}
              dropdownRender={(menu) => (
                <>
                  {/* 高度收紧：列表 + 底部操作条整体要留在视口内，否则操作条被屏幕底边截断 */}
                  <div style={{ maxHeight: 220, overflow: "auto" }}>{menu}</div>
                  <div
                    style={{
                      borderTop: "1px solid rgba(255,255,255,0.08)",
                      padding: "6px 8px",
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      disabled={
                        !manageTarget ||
                        manageTarget.id === activeVersionId
                      }
                      onClick={onRenameVersion}
                    >
                      重命名
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={
                        !manageTarget ||
                        manageTarget.id === activeVersionId ||
                        versions.length <= 1
                      }
                      onClick={onDeleteVersion}
                    >
                      删除
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<ClearOutlined />}
                      disabled={versions.length <= 1}
                      onClick={openBatchDelete}
                    >
                      批量删除
                    </Button>
                  </div>
                </>
              )}
            />
            {externalChanged && externalVersion ? (
              <>
                <Button size="small" onClick={ignoreExternalVersion}>
                  忽略外部修改
                </Button>
                <Button
                  type="primary"
                  size="small"
                  danger={dirtyRef.current}
                  loading={saving}
                  onClick={adoptExternalVersion}
                >
                  采用外部修改
                </Button>
              </>
            ) : pendingVersion ? (
              <>
                <Button size="small" onClick={cancelPendingVersion}>
                  取消切换
                </Button>
                <Button
                  type="primary"
                  size="small"
                  icon={<SwapOutlined />}
                  loading={saving}
                  onClick={confirmSwitchVersion}
                >
                  切换
                </Button>
              </>
            ) : pendingSave ? (
              <>
                <Button size="small" onClick={() => setPendingSave(false)}>
                  取消保存
                </Button>
                <Button
                  type="primary"
                  size="small"
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={onSaveClick}
                >
                  确认保存
                </Button>
              </>
            ) : dirty ? (
              <>
                {/* 有未保存改动：直接丢弃需二次确认；保存则先进入保存前对比预览 */}
                <Button
                  size="small"
                  danger
                  icon={<CloseOutlined />}
                  onClick={onDiscardChanges}
                >
                  放弃改动
                </Button>
                <Button
                  type="primary"
                  size="small"
                  icon={<SaveOutlined />}
                  onClick={() => setPendingSave(true)}
                >
                  保存
                </Button>
              </>
            ) : (
              <Button
                type="primary"
                size="small"
                icon={<SaveOutlined />}
                disabled
              >
                已保存
              </Button>
            )}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: 40 }}>
              <Spin />
            </div>
          ) : (
            <>
              {externalChanged && externalVersion ? (
                /* 外部改动对比：左 = 当前版本内容，右 = 外部更改（磁盘），由用户决定是否采用 */
                (() => {
                  const d = diffPaths(data, externalVersion.data);
                  const n = mergeDiffCount(d);
                  const extMissing = missingParts(externalVersion.data, data); // 外部侧已删除的模块 → 右侧幽灵展示
                  return (
                    <div className="jv-diff">
                      <DiffPane
                        side="orig"
                        icon={<HistoryOutlined />}
                        title="当前版本"
                        sub={versions.find((v) => v.id === activeVersionId)?.label || "未记录"}
                        count={n}
                        bodyRef={leftPaneRef}
                        onScroll={syncScroll(leftPaneRef, rightPaneRef)}
                      >
                        <ReadOnlyCtx.Provider value={true}>
                          {renderView(data, d, null, filter)}
                        </ReadOnlyCtx.Provider>
                      </DiffPane>
                      <DiffArrow label="采用 →" />
                      <DiffPane
                        side="mod"
                        icon={<UploadOutlined />}
                        title="外部更改"
                        sub="编辑器刚保存的磁盘内容"
                        count={n}
                        bodyRef={rightPaneRef}
                        onScroll={syncScroll(rightPaneRef, leftPaneRef)}
                      >
                        <ReadOnlyCtx.Provider value={true}>
                          {renderView(externalVersion.data, d, extMissing, filter)}
                        </ReadOnlyCtx.Provider>
                      </DiffPane>
                    </div>
                  );
                })()
              ) : pendingVersion ? (
                /* 切换预览：左 = 当前内容（只读），右 = 目标版本（只读），差异高亮 */
                (() => {
                  const d = diffPaths(data, pendingVersion.data);
                  const n = mergeDiffCount(d);
                  const tgtMissing = missingParts(pendingVersion.data, data); // 目标版本已删除的模块 → 右侧幽灵展示
                  return (
                    <div className="jv-diff">
                      <DiffPane
                        side="orig"
                        icon={<HistoryOutlined />}
                        title={dirty ? "当前版本（含未保存修改）" : "当前版本"}
                        sub={versions.find((v) => v.id === activeVersionId)?.label || "未记录"}
                        count={n}
                        bodyRef={leftPaneRef}
                        onScroll={syncScroll(leftPaneRef, rightPaneRef)}
                      >
                        <ReadOnlyCtx.Provider value={true}>
                          {renderView(data, d, null, filter)}
                        </ReadOnlyCtx.Provider>
                      </DiffPane>
                      <DiffArrow label="切换 →" />
                      <DiffPane
                        side="mod"
                        icon={<RollbackOutlined />}
                        title="切换目标"
                        sub={pendingVersion.label}
                        count={n}
                        bodyRef={rightPaneRef}
                        onScroll={syncScroll(rightPaneRef, leftPaneRef)}
                      >
                        <ReadOnlyCtx.Provider value={true}>
                          {renderView(pendingVersion.data, d, tgtMissing, filter)}
                        </ReadOnlyCtx.Provider>
                      </DiffPane>
                    </div>
                  );
                })()
              ) : pendingSave ? (
                /* 保存前对比：点「保存」才进入 —— 左 = 当前版本（只读），右 = 未保存的修改，确认后落盘 */
                (() => {
                  const n = mergeDiffCount(changedPaths);
                  const delParts = missingParts(data, savedData); // 本次编辑删掉的模块 → 右侧幽灵展示
                  return (
                    <div className="jv-diff">
                      <DiffPane
                        side="orig"
                        icon={<HistoryOutlined />}
                        title="当前版本"
                        sub={versions.find((v) => v.id === activeVersionId)?.label || "已保存"}
                        count={n}
                        bodyRef={leftPaneRef}
                        onScroll={syncScroll(leftPaneRef, rightPaneRef)}
                      >
                        <ReadOnlyCtx.Provider value={true}>
                          {renderView(savedData, changedPaths, null, filter)}
                        </ReadOnlyCtx.Provider>
                      </DiffPane>
                      <DiffArrow label="保存 →" />
                      <DiffPane
                        side="mod"
                        icon={<FileTextOutlined />}
                        title="本次保存的修改"
                        sub="确认后写入本地文件并记录版本"
                        count={n}
                        bodyRef={rightPaneRef}
                        onScroll={syncScroll(rightPaneRef, leftPaneRef)}
                      >
                        {renderView(data, changedPaths, delParts, filter)}
                      </DiffPane>
                    </div>
                  );
                })()
              ) : dirty ? (
                /* 编辑中：单栏可编辑，改动处橙色内联高亮，不打断编辑流 */
                <div className="jv-single">{renderView(data, changedPaths, null, filter)}</div>
              ) : (
                <div className="jv-single">{renderView(data, changedPaths, null, filter)}</div>
              )}
            </>
          )}
        </div>
      )}
      </div>

      {/* 批量删除版本弹窗：勾选要删的版本，当前版本不可选 */}
      <Modal
        open={batchDelOpen}
        title="批量删除历史版本"
        okText={`删除（${batchDelIds.size}）`}
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: batchDelIds.size === 0 }}
        onOk={onBatchDelete}
        onCancel={() => setBatchDelOpen(false)}
        width={460}
      >
        <div style={{ maxHeight: 320, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {versions.map((v) => {
            const isCur = v.id === activeVersionId;
            return (
              <label
                key={v.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 6px",
                  borderRadius: 6,
                  cursor: isCur ? "not-allowed" : "pointer",
                  opacity: isCur ? 0.5 : 1,
                }}
              >
                <input
                  type="checkbox"
                  disabled={isCur}
                  checked={batchDelIds.has(v.id)}
                  onChange={(e) => {
                    setBatchDelIds((cur) => {
                      const next = new Set(cur);
                      if (e.target.checked) next.add(v.id);
                      else next.delete(v.id);
                      return next;
                    });
                  }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.label}
                  {isCur && (
                    <span className="jv-badge" style={{ marginLeft: 6 }}>
                      当前
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
          已勾选 {batchDelIds.size} 个，删除后不可恢复；当前版本不会删除。
        </div>
      </Modal>
    </div>
  );
}
