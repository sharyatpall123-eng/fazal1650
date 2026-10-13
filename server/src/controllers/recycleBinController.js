import { supabaseAdmin } from "../config/supabase.js";
import { ApiError, asyncHandler, sendData } from "../utils/http.js";

const tableByType = {
  warehouse: "warehouses",
  debtor: "customers",
  product: "products",
  representative: "representatives",
};

const deletedById = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") return value.id || null;
  return null;
};

const fallbackLabel = (row) =>
  row?.label ||
  row?.data?.recycle_label ||
  row?.data?.name ||
  row?.data?.sku ||
  row?.entity_id ||
  "ریکارډ";

export const listRecycleBin = asyncHandler(async (request, response) => {
  let query = supabaseAdmin.from("recycle_bin").select("*").order("deleted_at", { ascending: false });
  if (request.query.type && request.query.type !== "all") query = query.eq("entity_type", request.query.type);
  const { data, error } = await query;
  if (error) throw new ApiError(400, error.message);

  const baseRows = data || [];
  const profileIds = [...new Set(baseRows.map((row) => deletedById(row.deleted_by)).filter(Boolean))];
  let profileById = new Map();

  if (profileIds.length) {
    const { data: profiles, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("id,full_name,email,username")
      .in("id", profileIds);

    if (!profileError) {
      profileById = new Map((profiles || []).map((profile) => [profile.id, profile]));
    }
  }

  const normalized = baseRows.map((row) => {
    const actorId = deletedById(row.deleted_by);
    const profile = actorId ? profileById.get(actorId) : null;
    const existingActor = row.deleted_by && typeof row.deleted_by === "object" ? row.deleted_by : null;
    return {
      ...row,
      label: fallbackLabel(row),
      deleted_by: actorId || existingActor
        ? {
            id: actorId || existingActor?.id || null,
            name: existingActor?.name || profile?.full_name || profile?.username || profile?.email || "—",
          }
        : null,
    };
  });

  const q = String(request.query.search || "").trim().toLowerCase();
  const rows = q
    ? normalized.filter((row) =>
        [row.label, row.entity_type, row.deleted_by?.name]
          .some((value) => String(value || "").toLowerCase().includes(q)),
      )
    : normalized;

  return sendData(response, rows, "Recycle bin loaded", 200, { total: rows.length });
});

export const restoreRecycleItem = asyncHandler(async (request, response) => {
  const { data: trash, error: findError } = await supabaseAdmin.from("recycle_bin").select("*").eq("id", request.params.id).single();
  if (findError || !trash) throw new ApiError(404, "Recycle Bin ریکارډ پیدا نه شو.");

  const table = tableByType[trash.entity_type];
  if (!table) throw new ApiError(400, "د دې ریکارډ Restore نه ملاتړ کېږي.");
  if (!trash.data || typeof trash.data !== "object" || Array.isArray(trash.data)) {
    throw new ApiError(400, "د Restore لپاره اصلي معلومات نشته.");
  }

  const row = { ...trash.data };
  delete row.recycle_label;
  if (trash.entity_type === "product") delete row.stock_status;
  row.is_active = true;

  const { data: restored, error } = await supabaseAdmin
    .from(table)
    .upsert(row, { onConflict: "id" })
    .select()
    .single();
  if (error) throw new ApiError(400, `Restore ناکام شو: ${error.message}`);

  const { error: cleanupError } = await supabaseAdmin.from("recycle_bin").delete().eq("id", trash.id);
  if (cleanupError) {
    throw new ApiError(400, `ریکارډ Restore شو، خو Recycle Bin پاک نه شو: ${cleanupError.message}`);
  }

  return sendData(response, { success: true, restored: restored || row, entity_type: trash.entity_type }, "Restored");
});

export const permanentlyDelete = asyncHandler(async (request, response) => {
  const { data, error } = await supabaseAdmin.from("recycle_bin").delete().eq("id", request.params.id).select("id").single();
  if (error || !data) throw new ApiError(400, error?.message || "Permanent delete failed");
  return sendData(response, { success: true, id: data.id }, "Permanently deleted");
});
