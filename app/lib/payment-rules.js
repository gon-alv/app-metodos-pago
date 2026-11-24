export const METAFIELD_NAMESPACE = "$app:payment-filter";
export const KEY_UI_CONFIG = "ui-config";
export const KEY_RULES_CONFIG = "rules-config";
export const KEY_INPUT_VARS = "input-vars";
export const FUNCTION_HANDLE = "personalizacion-pagos";

export const MAX_METAFIELD_SLOTS = 4;
export const MAX_RULES_CONFIG_BYTES = 9800;
export const MAX_LIST_VAR_ITEMS = 100;
export const UNUSED_METAFIELD_SENTINEL = "__unused__";

export const CONDITION_FIELDS = [
  { value: "tag", label: "Etiqueta (Tag)" },
  { value: "collection", label: "Colección" },
  { value: "product_type", label: "Tipo de producto" },
  { value: "vendor", label: "Proveedor (Vendor)" },
  { value: "sku", label: "SKU de variante" },
  { value: "title", label: "Título del producto" },
  { value: "metafield", label: "Metacampo de producto" },
];

export const OPERATOR_LABELS = {
  equals: "Es igual a",
  not_equals: "No es igual a",
  in: "Pertenece a",
  not_in: "No pertenece a",
  contains: "Contiene",
  not_contains: "No contiene",
  starts_with: "Empieza por",
  is_empty: "Está vacío",
  is_not_empty: "No está vacío",
  gt: "Mayor que (>)",
  gte: "Mayor o igual que (>=)",
  lt: "Menor que (<)",
  lte: "Menor o igual que (<=)",
};

export const OPERATORS_BY_FIELD = {
  tag: ["equals", "not_equals"],
  collection: ["in", "not_in"],
  product_type: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "is_empty",
    "is_not_empty",
  ],
  vendor: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "is_empty",
    "is_not_empty",
  ],
  sku: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "is_empty",
    "is_not_empty",
  ],
  title: ["equals", "not_equals", "contains", "not_contains", "starts_with"],
  metafield: [
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "is_empty",
    "is_not_empty",
    "gt",
    "gte",
    "lt",
    "lte",
  ],
};

export const VALUELESS_OPERATORS = new Set(["is_empty", "is_not_empty"]);

export const DEFAULT_PAYMENT_METHODS_CATALOG = [
  {
    id: "pm-transferencia",
    label: "Transferencia directa",
    pattern: "transferencia directa",
    matchType: "contains",
  },
  {
    id: "pm-tienda",
    label: "Pago en tienda",
    pattern: "pago en tienda",
    matchType: "contains",
  },
  {
    id: "pm-tarjeta",
    label: "Tarjeta de crédito / débito",
    pattern: "tarjeta",
    matchType: "contains",
  },
  {
    id: "pm-mercadopago",
    label: "Mercado Pago",
    pattern: "mercado pago",
    matchType: "contains",
  },
  {
    id: "pm-paypal",
    label: "PayPal",
    pattern: "paypal",
    matchType: "contains",
  },
];

export const SAMPLE_RULE_TEMPLATES = [
  {
    id: "tpl-reacondicionado",
    name: "Solo transferencia directa para reacondicionados",
    enabled: true,
    cartMatch: "any",
    conditionLogic: "all",
    conditions: [
      {
        id: "cond-tpl-1",
        field: "tag",
        operator: "equals",
        value: "reacondicionado",
        metafieldNamespace: "",
        metafieldKey: "",
      },
    ],
    action: "allow_only_selected",
    targets: [
      {
        pattern: "transferencia directa",
        matchType: "contains",
        label: "Transferencia directa",
      },
    ],
  },
  {
    id: "tpl-servicio-tecnico",
    name: "Ocultar pago en tienda para servicio técnico",
    enabled: true,
    cartMatch: "any",
    conditionLogic: "all",
    conditions: [
      {
        id: "cond-tpl-2",
        field: "tag",
        operator: "equals",
        value: "servicio-tecnico",
        metafieldNamespace: "",
        metafieldKey: "",
      },
    ],
    action: "hide_selected",
    targets: [
      {
        pattern: "pago en tienda",
        matchType: "contains",
        label: "Pago en tienda",
      },
    ],
  },
];

function makeId(prefix = "id") {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function createEmptyCondition(field = "tag") {
  const allowedOperators = OPERATORS_BY_FIELD[field] || OPERATORS_BY_FIELD.tag;
  return {
    id: makeId("cond"),
    field,
    operator: allowedOperators[0],
    value: "",
    metafieldNamespace: field === "metafield" ? "custom" : "",
    metafieldKey: "",
  };
}

export function createEmptyRule() {
  return {
    id: makeId("rule"),
    name: "",
    enabled: true,
    cartMatch: "any",
    conditionLogic: "all",
    conditions: [createEmptyCondition("tag")],
    action: "hide_selected",
    targets: [],
  };
}

export function createDefaultUiConfig() {
  return {
    version: 1,
    failSafe: true,
    catalog: DEFAULT_PAYMENT_METHODS_CATALOG.map((item) => ({ ...item })),
    rules: [],
  };
}

function normalizeTarget(rawTarget) {
  if (!rawTarget || typeof rawTarget !== "object") {
    return null;
  }
  const pattern = String(rawTarget.pattern || "").trim();
  if (!pattern) {
    return null;
  }
  const matchType = rawTarget.matchType === "exact" ? "exact" : "contains";
  const label = String(rawTarget.label || pattern).trim();
  return {
    pattern,
    matchType,
    label,
  };
}

function normalizeCondition(rawCond) {
  const field = CONDITION_FIELDS.some((f) => f.value === rawCond?.field)
    ? rawCond.field
    : "tag";
  const allowedOps = OPERATORS_BY_FIELD[field] || OPERATORS_BY_FIELD.tag;
  const operator = allowedOps.includes(rawCond?.operator)
    ? rawCond.operator
    : allowedOps[0];

  return {
    id: String(rawCond?.id || makeId("cond")),
    field,
    operator,
    value: String(rawCond?.value ?? "").trim(),
    metafieldNamespace:
      field === "metafield"
        ? String(rawCond?.metafieldNamespace ?? "").trim()
        : "",
    metafieldKey:
      field === "metafield" ? String(rawCond?.metafieldKey ?? "").trim() : "",
  };
}

export function normalizeRule(rawRule) {
  const conditions = Array.isArray(rawRule?.conditions)
    ? rawRule.conditions.map(normalizeCondition)
    : [];

  const targets = Array.isArray(rawRule?.targets)
    ? rawRule.targets.map(normalizeTarget).filter(Boolean)
    : [];

  return {
    id: String(rawRule?.id || makeId("rule")),
    name: String(rawRule?.name ?? "").trim(),
    enabled: rawRule?.enabled !== false,
    cartMatch: rawRule?.cartMatch === "all" ? "all" : "any",
    conditionLogic: rawRule?.conditionLogic === "any" ? "any" : "all",
    conditions: conditions.length > 0 ? conditions : [createEmptyCondition("tag")],
    action:
      rawRule?.action === "allow_only_selected"
        ? "allow_only_selected"
        : "hide_selected",
    targets,
  };
}

export function normalizeCatalogMethod(rawMethod) {
  if (!rawMethod || typeof rawMethod !== "object") {
    return null;
  }
  const pattern = String(rawMethod.pattern ?? "").trim();
  if (!pattern) {
    return null;
  }
  const label = String(rawMethod.label || pattern).trim();
  const matchType = rawMethod.matchType === "exact" ? "exact" : "contains";
  return {
    id: String(rawMethod.id || makeId("pm")),
    label,
    pattern,
    matchType,
  };
}

export function normalizeUiConfig(raw) {
  if (!raw || typeof raw !== "object") {
    return createDefaultUiConfig();
  }

  const catalog = Array.isArray(raw.catalog)
    ? raw.catalog.map(normalizeCatalogMethod).filter(Boolean)
    : DEFAULT_PAYMENT_METHODS_CATALOG.map((item) => ({ ...item }));

  const rules = Array.isArray(raw.rules)
    ? raw.rules.map(normalizeRule)
    : [];

  return {
    version: 1,
    failSafe: raw.failSafe !== false,
    catalog,
    rules,
  };
}

export function validateCatalogMethod(method) {
  const errors = {};
  const label = String(method?.label ?? "").trim();
  const pattern = String(method?.pattern ?? "").trim();

  if (!label) {
    errors.label = "Ingresa un nombre visible para el método de pago.";
  }
  if (!pattern) {
    errors.pattern =
      "Ingresa el texto o nombre exacto que aparece en el checkout.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function validateRule(rule) {
  const errors = {
    name: null,
    conditions: [],
    targets: null,
  };
  let hasError = false;

  if (!String(rule?.name ?? "").trim()) {
    errors.name = "Ingresa un nombre descriptivo para la regla.";
    hasError = true;
  }

  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  if (conditions.length === 0) {
    errors.conditions.push({ general: "Agrega al menos una condición." });
    hasError = true;
  } else {
    conditions.forEach((cond, idx) => {
      const condErrors = {};
      const allowedOps = OPERATORS_BY_FIELD[cond?.field] || [];
      if (!allowedOps.includes(cond?.operator)) {
        condErrors.operator = "Operador inválido para el campo seleccionado.";
      }

      if (cond?.field === "metafield") {
        if (!String(cond?.metafieldNamespace ?? "").trim()) {
          condErrors.metafieldNamespace =
            "Ingresa el namespace del metacampo (ej. custom).";
        }
        if (!String(cond?.metafieldKey ?? "").trim()) {
          condErrors.metafieldKey = "Ingresa la clave (key) del metacampo.";
        }
      }

      if (!VALUELESS_OPERATORS.has(cond?.operator)) {
        const val = String(cond?.value ?? "").trim();
        if (!val) {
          condErrors.value = "Ingresa un valor para comparar.";
        } else if (["gt", "gte", "lt", "lte"].includes(cond?.operator)) {
          const parsed = Number(val);
          if (!Number.isFinite(parsed)) {
            condErrors.value = "Este operador requiere un valor numérico.";
          }
        }
      }

      if (Object.keys(condErrors).length > 0) {
        hasError = true;
      }
      errors.conditions[idx] = condErrors;
    });
  }

  const targets = Array.isArray(rule?.targets)
    ? rule.targets.filter((t) => String(t?.pattern ?? "").trim().length > 0)
    : [];
  if (targets.length === 0) {
    errors.targets =
      "Selecciona o agrega al menos un método de pago objetivo.";
    hasError = true;
  }

  return {
    valid: !hasError,
    errors,
  };
}

export function getUtf8ByteLength(text) {
  return new TextEncoder().encode(text).length;
}

export function compileFunctionPayloads(rawConfig) {
  const uiConfig = normalizeUiConfig(rawConfig);
  const activeRules = uiConfig.rules.filter((rule) => rule.enabled);

  const watchedTagsSet = new Set();
  const watchedCollectionsSet = new Set();
  const metafieldSlotMap = new Map();
  const activeMetafields = [];

  for (const rule of activeRules) {
    const validation = validateRule(rule);
    if (!validation.valid) {
      return {
        ok: false,
        error: `La regla "${rule.name || "Sin nombre"}" contiene errores de validación.`,
      };
    }
  }

  const compiledRules = [];

  for (const rule of activeRules) {
    const compiledConditions = [];

    for (const cond of rule.conditions) {
      let metafieldSlot = -1;

      if (cond.field === "tag") {
        const tagVal = cond.value.trim();
        if (tagVal) {
          watchedTagsSet.add(tagVal);
        }
      } else if (cond.field === "collection") {
        const colId = cond.value.trim();
        if (colId) {
          watchedCollectionsSet.add(colId);
        }
      } else if (cond.field === "metafield") {
        const ns = cond.metafieldNamespace.trim();
        const key = cond.metafieldKey.trim();
        const composite = `${ns}\0${key}`;

        if (metafieldSlotMap.has(composite)) {
          metafieldSlot = metafieldSlotMap.get(composite);
        } else {
          if (activeMetafields.length >= MAX_METAFIELD_SLOTS) {
            return {
              ok: false,
              error: `Shopify Functions permite un máximo de ${MAX_METAFIELD_SLOTS} metacampos de producto distintos en reglas activas. Pausa o unifica reglas para liberar un espacio.`,
            };
          }
          metafieldSlot = activeMetafields.length;
          metafieldSlotMap.set(composite, metafieldSlot);
          activeMetafields.push({ namespace: ns, key });
        }
      }

      compiledConditions.push({
        field: cond.field,
        operator: cond.operator,
        value: VALUELESS_OPERATORS.has(cond.operator) ? "" : cond.value.trim(),
        metafieldSlot,
      });
    }

    compiledRules.push({
      cartMatch: rule.cartMatch,
      conditionLogic: rule.conditionLogic,
      conditions: compiledConditions,
      action: rule.action,
      targets: rule.targets.map((target) => ({
        pattern: target.pattern.trim(),
        matchType: target.matchType === "exact" ? "exact" : "contains",
      })),
    });
  }

  const watchedTags = Array.from(watchedTagsSet);
  if (watchedTags.length > MAX_LIST_VAR_ITEMS) {
    return {
      ok: false,
      error: `Superaste el límite de ${MAX_LIST_VAR_ITEMS} etiquetas únicas activas en Shopify Functions (${watchedTags.length}).`,
    };
  }

  const watchedCollections = Array.from(watchedCollectionsSet);
  if (watchedCollections.length > MAX_LIST_VAR_ITEMS) {
    return {
      ok: false,
      error: `Superaste el límite de ${MAX_LIST_VAR_ITEMS} colecciones únicas activas en Shopify Functions (${watchedCollections.length}).`,
    };
  }

  const slot = (idx) =>
    activeMetafields[idx] || {
      namespace: UNUSED_METAFIELD_SENTINEL,
      key: UNUSED_METAFIELD_SENTINEL,
    };

  const inputVars = {
    watchedTags,
    watchedCollections,
    mf0Ns: slot(0).namespace,
    mf0Key: slot(0).key,
    mf1Ns: slot(1).namespace,
    mf1Key: slot(1).key,
    mf2Ns: slot(2).namespace,
    mf2Key: slot(2).key,
    mf3Ns: slot(3).namespace,
    mf3Key: slot(3).key,
  };

  const rulesConfig = {
    failSafe: uiConfig.failSafe,
    rules: compiledRules,
  };

  const rulesConfigJson = JSON.stringify(rulesConfig);
  const rulesConfigBytes = getUtf8ByteLength(rulesConfigJson);

  if (rulesConfigBytes > MAX_RULES_CONFIG_BYTES) {
    return {
      ok: false,
      error: `La configuración compilada de reglas activas ocupa ${rulesConfigBytes} bytes y supera el límite seguro de ${MAX_RULES_CONFIG_BYTES} bytes de Shopify Functions.`,
    };
  }

  return {
    ok: true,
    error: null,
    uiConfig,
    rulesConfig,
    inputVars,
    rulesConfigBytes,
    activeMetafields,
    watchedTagsCount: watchedTags.length,
    watchedCollectionsCount: watchedCollections.length,
  };
}

export function formatConditionSummary(cond, collectionsById = {}) {
  const fieldObj = CONDITION_FIELDS.find((f) => f.value === cond.field);
  const opLabel = OPERATOR_LABELS[cond.operator] || cond.operator;

  let fieldText = fieldObj ? fieldObj.label : cond.field;
  if (cond.field === "metafield") {
    const ns = cond.metafieldNamespace || "?";
    const key = cond.metafieldKey || "?";
    fieldText = `Metacampo ${ns}.${key}`;
  }

  if (VALUELESS_OPERATORS.has(cond.operator)) {
    return `${fieldText} ${opLabel.toLowerCase()}`;
  }

  let valueText = cond.value;
  if (cond.field === "collection" && collectionsById[cond.value]) {
    valueText = collectionsById[cond.value];
  }

  return `${fieldText} ${opLabel.toLowerCase()} "${valueText}"`;
}

export function formatRuleSummary(rule, collectionsById = {}) {
  const cartText =
    rule.cartMatch === "all"
      ? "Si TODOS los productos del carrito cumplen"
      : "Si algún producto del carrito cumple";

  const joiner = rule.conditionLogic === "any" ? " O " : " Y ";
  const condText = (rule.conditions || [])
    .map((c) => formatConditionSummary(c, collectionsById))
    .join(joiner);

  const actionText =
    rule.action === "allow_only_selected"
      ? "mostrar SOLO"
      : "ocultar";

  const targetList = (rule.targets || [])
    .map((t) => `"${t.label || t.pattern}"`)
    .join(", ");

  return `${cartText} (${condText || "sin condiciones"}) → ${actionText}: ${targetList || "ningún método"}`;
}
