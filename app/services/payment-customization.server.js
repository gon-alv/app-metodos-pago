import {
  compileFunctionPayloads,
  createDefaultUiConfig,
  FUNCTION_HANDLE,
  KEY_INPUT_VARS,
  KEY_RULES_CONFIG,
  KEY_UI_CONFIG,
  METAFIELD_NAMESPACE,
  normalizeUiConfig,
} from "../lib/payment-rules";

const CUSTOMIZATION_TITLE = "Reglas de métodos de pago";

const LOAD_PAYMENT_CUSTOMIZATIONS_QUERY = `#graphql
  query LoadPaymentCustomizations {
    paymentCustomizations(first: 25) {
      nodes {
        id
        title
        enabled
        functionId
        uiConfig: metafield(namespace: "$app:payment-filter", key: "ui-config") {
          value
        }
        rulesConfig: metafield(namespace: "$app:payment-filter", key: "rules-config") {
          value
        }
        inputVars: metafield(namespace: "$app:payment-filter", key: "input-vars") {
          value
        }
      }
    }
    shopifyFunctions(first: 25) {
      nodes {
        id
        title
        apiType
      }
    }
  }
`;

const LOAD_CATALOG_METADATA_QUERY = `#graphql
  query LoadCatalogMetadata {
    metafieldDefinitions(ownerType: PRODUCT, first: 100) {
      nodes {
        id
        name
        namespace
        key
        type {
          name
        }
      }
    }
    collections(first: 100) {
      nodes {
        id
        title
        handle
      }
    }
    productTags(first: 250) {
      nodes
    }
    productTypes(first: 250) {
      nodes
    }
    productVendors(first: 250) {
      nodes
    }
  }
`;

const CREATE_PAYMENT_CUSTOMIZATION_MUTATION = `#graphql
  mutation CreatePaymentCustomization($paymentCustomization: PaymentCustomizationInput!) {
    paymentCustomizationCreate(paymentCustomization: $paymentCustomization) {
      paymentCustomization {
        id
        title
        enabled
        functionId
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const UPDATE_PAYMENT_CUSTOMIZATION_MUTATION = `#graphql
  mutation UpdatePaymentCustomization($id: ID!, $paymentCustomization: PaymentCustomizationInput!) {
    paymentCustomizationUpdate(id: $id, paymentCustomization: $paymentCustomization) {
      paymentCustomization {
        id
        title
        enabled
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const SAVE_METAFIELDS_MUTATION = `#graphql
  mutation SavePaymentCustomizationMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

function safeParseJson(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatGraphqlErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }
  return errors.map((e) => e.message).filter(Boolean).join("; ");
}

function formatUserErrors(userErrors) {
  if (!Array.isArray(userErrors) || userErrors.length === 0) {
    return null;
  }
  return userErrors.map((e) => e.message).filter(Boolean).join("; ");
}

function buildMetafieldsPayload(uiConfig, compiled, ownerId = null) {
  const entries = [
    {
      namespace: METAFIELD_NAMESPACE,
      key: KEY_UI_CONFIG,
      type: "json",
      value: JSON.stringify(uiConfig),
    },
    {
      namespace: METAFIELD_NAMESPACE,
      key: KEY_RULES_CONFIG,
      type: "json",
      value: JSON.stringify(compiled.rulesConfig),
    },
    {
      namespace: METAFIELD_NAMESPACE,
      key: KEY_INPUT_VARS,
      type: "json",
      value: JSON.stringify(compiled.inputVars),
    },
  ];

  if (ownerId) {
    return entries.map((entry) => ({ ...entry, ownerId }));
  }
  return entries;
}

async function runGraphql(admin, query, variables = undefined) {
  const response = await admin.graphql(
    query,
    variables ? { variables } : undefined,
  );
  return response.json();
}

export async function loadPaymentFilterState(admin) {
  const coreJson = await runGraphql(admin, LOAD_PAYMENT_CUSTOMIZATIONS_QUERY);
  const coreError = formatGraphqlErrors(coreJson?.errors);

  if (coreError) {
    throw new Error(
      `No se pudo consultar Shopify Payment Customizations: ${coreError}`,
    );
  }

  const customizations = coreJson?.data?.paymentCustomizations?.nodes || [];
  const functions = coreJson?.data?.shopifyFunctions?.nodes || [];

  const paymentFunction =
    functions.find((fn) => fn.apiType === "payment_customization") || null;

  const existingCustomization =
    customizations.find(
      (pc) => paymentFunction && pc.functionId === paymentFunction.id,
    ) ||
    customizations.find(
      (pc) => pc.uiConfig != null || pc.rulesConfig != null,
    ) ||
    null;

  const parsedUi = safeParseJson(existingCustomization?.uiConfig?.value);
  const uiConfig = parsedUi
    ? normalizeUiConfig(parsedUi)
    : createDefaultUiConfig();

  const compiled = compileFunctionPayloads(uiConfig);

  let metadataWarning = null;
  let metafieldDefinitions = [];
  let collections = [];
  let productTags = [];
  let productTypes = [];
  let productVendors = [];

  try {
    const metaJson = await runGraphql(admin, LOAD_CATALOG_METADATA_QUERY);
    const metaErr = formatGraphqlErrors(metaJson?.errors);
    if (metaErr) {
      metadataWarning = metaErr;
    }
    if (metaJson?.data) {
      metafieldDefinitions = metaJson.data.metafieldDefinitions?.nodes || [];
      collections = metaJson.data.collections?.nodes || [];
      productTags = (metaJson.data.productTags?.nodes || []).filter(Boolean);
      productTypes = (metaJson.data.productTypes?.nodes || []).filter(Boolean);
      productVendors = (metaJson.data.productVendors?.nodes || []).filter(
        Boolean,
      );
    }
  } catch (err) {
    metadataWarning = err?.message || "No se pudo cargar el catálogo de productos.";
  }

  return {
    customization: existingCustomization
      ? {
          id: existingCustomization.id,
          title: existingCustomization.title,
          enabled: Boolean(existingCustomization.enabled),
          functionId: existingCustomization.functionId,
        }
      : null,
    functionDeployed: Boolean(paymentFunction),
    uiConfig,
    metrics: compiled.ok
      ? {
          rulesConfigBytes: compiled.rulesConfigBytes,
          activeMetafields: compiled.activeMetafields,
          watchedTagsCount: compiled.watchedTagsCount,
          watchedCollectionsCount: compiled.watchedCollectionsCount,
        }
      : {
          rulesConfigBytes: 0,
          activeMetafields: [],
          watchedTagsCount: 0,
          watchedCollectionsCount: 0,
          compileError: compiled.error,
        },
    storeCatalog: {
      metafieldDefinitions,
      collections,
      productTags,
      productTypes,
      productVendors,
    },
    metadataWarning,
  };
}

export async function saveUiConfig(admin, rawUiConfig, { enabled } = {}) {
  const uiConfig = normalizeUiConfig(rawUiConfig);
  const compiled = compileFunctionPayloads(uiConfig);

  if (!compiled.ok) {
    return {
      ok: false,
      error: compiled.error,
    };
  }

  const coreJson = await runGraphql(admin, LOAD_PAYMENT_CUSTOMIZATIONS_QUERY);
  const coreError = formatGraphqlErrors(coreJson?.errors);
  if (coreError) {
    return {
      ok: false,
      error: `Error al consultar personalizaciones de pago: ${coreError}`,
    };
  }

  const customizations = coreJson?.data?.paymentCustomizations?.nodes || [];
  const functions = coreJson?.data?.shopifyFunctions?.nodes || [];
  const paymentFunction =
    functions.find((fn) => fn.apiType === "payment_customization") || null;

  const existing =
    customizations.find(
      (pc) => paymentFunction && pc.functionId === paymentFunction.id,
    ) ||
    customizations.find(
      (pc) => pc.uiConfig != null || pc.rulesConfig != null,
    ) ||
    null;

  if (!existing) {
    const createJson = await runGraphql(
      admin,
      CREATE_PAYMENT_CUSTOMIZATION_MUTATION,
      {
        paymentCustomization: {
          title: CUSTOMIZATION_TITLE,
          enabled: typeof enabled === "boolean" ? enabled : true,
          functionHandle: FUNCTION_HANDLE,
          metafields: buildMetafieldsPayload(uiConfig, compiled),
        },
      },
    );

    const gqlErr = formatGraphqlErrors(createJson?.errors);
    if (gqlErr) {
      return { ok: false, error: gqlErr };
    }

    const userErr = formatUserErrors(
      createJson?.data?.paymentCustomizationCreate?.userErrors,
    );
    if (userErr) {
      return { ok: false, error: userErr };
    }

    return {
      ok: true,
      customization:
        createJson?.data?.paymentCustomizationCreate?.paymentCustomization ||
        null,
      uiConfig,
    };
  }

  const mfJson = await runGraphql(admin, SAVE_METAFIELDS_MUTATION, {
    metafields: buildMetafieldsPayload(uiConfig, compiled, existing.id),
  });
  const mfGqlErr = formatGraphqlErrors(mfJson?.errors);
  if (mfGqlErr) {
    return { ok: false, error: mfGqlErr };
  }
  const mfUserErr = formatUserErrors(mfJson?.data?.metafieldsSet?.userErrors);
  if (mfUserErr) {
    return { ok: false, error: mfUserErr };
  }

  if (typeof enabled === "boolean" && enabled !== existing.enabled) {
    const toggleRes = await setCustomizationEnabled(
      admin,
      existing.id,
      enabled,
    );
    if (!toggleRes.ok) {
      return toggleRes;
    }
  }

  return {
    ok: true,
    customization: existing,
    uiConfig,
  };
}

export async function setCustomizationEnabled(admin, customizationId, enabled) {
  const updateJson = await runGraphql(
    admin,
    UPDATE_PAYMENT_CUSTOMIZATION_MUTATION,
    {
      id: customizationId,
      paymentCustomization: {
        title: CUSTOMIZATION_TITLE,
        enabled: Boolean(enabled),
      },
    },
  );

  const gqlErr = formatGraphqlErrors(updateJson?.errors);
  if (gqlErr) {
    return { ok: false, error: gqlErr };
  }

  const userErr = formatUserErrors(
    updateJson?.data?.paymentCustomizationUpdate?.userErrors,
  );
  if (userErr) {
    return { ok: false, error: userErr };
  }

  return {
    ok: true,
    customization:
      updateJson?.data?.paymentCustomizationUpdate?.paymentCustomization || null,
  };
}
