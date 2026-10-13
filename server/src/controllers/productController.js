import { supabaseAdmin } from "../config/supabase.js";
import { ApiError, asyncHandler, sendData } from "../utils/http.js";

const numeric = ["quantity", "min_stock", "purchase_price", "selling_price"];
const cleanPayload = (body) => {
  const allowed = ["name", "sku", "barcode", "category", "unit", "quantity", "min_stock", "purchase_price", "selling_price", "description", "image_url", "currency", "warehouse_id"];
  const payload = {};
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    if (numeric.includes(key)) {
      payload[key] = Number(body[key] || 0);
    } else if (key === "barcode") {
      payload[key] = String(body[key] ?? "").trim() || null;
    } else {
      payload[key] = body[key];
    }
  }
  return payload;
};

export const listProducts = asyncHandler(async (request, response) => {
  const page = Math.max(1, Number(request.query.page || 1));
  const limit = Math.min(500, Math.max(1, Number(request.query.limit || 24)));
  const from = (page - 1) * limit;
  const to = from + limit - 1;
  const search = String(request.query.search || "").trim();
  const status = String(request.query.status || "all");

  let query = supabaseAdmin.from("products").select("*", { count: "exact" }).eq("is_active", true).order("created_at", { ascending: false });
  if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%,barcode.ilike.%${search}%`);
  if (["out", "low", "in"].includes(status)) query = query.eq("stock_status", status);
  if (request.query.warehouse_id) query = query.eq("warehouse_id", String(request.query.warehouse_id));

  const { data, error, count } = await query.range(from, to);
  if (error) throw new ApiError(400, error.message);
  return sendData(response, data || [], "Products loaded", 200, { total: count || 0, page, limit, totalPages: Math.max(1, Math.ceil((count || 0) / limit)) });
});

export const getProduct = asyncHandler(async (request, response) => {
  const { data, error } = await supabaseAdmin.from("products").select("*").eq("id", request.params.id).single();
  if (error || !data) throw new ApiError(404, "محصول پیدا نه شو.");
  return sendData(response, data);
});

export const createProduct = asyncHandler(async (request, response) => {
  const payload = cleanPayload(request.body);
  const quantity = Number(payload.quantity || 0);
  if (!payload.warehouse_id) throw new ApiError(400, "ګدام انتخابول ضروري دي.");
  if (quantity <= 0) throw new ApiError(400, "تعداد ضروري دی او باید له صفر څخه زیات وي.");
  if (!String(payload.name || "").trim()) payload.name = `جنس ${Date.now()}`;
  if (!String(payload.sku || "").trim()) payload.sku = `AUTO-${Date.now()}`;
  const { data, error } = await supabaseAdmin.from("products").insert({ ...payload, quantity, created_by: request.auth.user.id }).select().single();
  if (error) {
    if (error.code === "23505" && String(error.message || "").includes("products_barcode_key")) {
      throw new ApiError(400, "دا بارکوډ مخکې د بل محصول لپاره ثبت شوی دی.");
    }
    if (error.code === "23505" && String(error.message || "").includes("products_sku_key")) {
      throw new ApiError(400, "دا SKU مخکې د بل محصول لپاره ثبت شوی دی.");
    }
    throw new ApiError(400, error.message);
  }
  await supabaseAdmin.from("activity_logs").insert({ user_id: request.auth.user.id, action: "product_created", entity_type: "product", entity_id: data.id, details: { name: data.name } });
  return sendData(response, data, "Product created", 201);
});

export const updateProduct = asyncHandler(async (request, response) => {
  const payload = cleanPayload(request.body);
  const { data, error } = await supabaseAdmin.from("products").update(payload).eq("id", request.params.id).select().single();
  if (error || !data) {
    if (error?.code === "23505" && String(error.message || "").includes("products_barcode_key")) {
      throw new ApiError(400, "دا بارکوډ مخکې د بل محصول لپاره ثبت شوی دی.");
    }
    if (error?.code === "23505" && String(error.message || "").includes("products_sku_key")) {
      throw new ApiError(400, "دا SKU مخکې د بل محصول لپاره ثبت شوی دی.");
    }
    throw new ApiError(400, error?.message || "Product update failed");
  }
  await supabaseAdmin.from("activity_logs").insert({ user_id: request.auth.user.id, action: "product_updated", entity_type: "product", entity_id: data.id });
  return sendData(response, data, "Product updated");
});

export const deleteProduct = asyncHandler(async (request, response) => {
  const { data: row, error: findError } = await supabaseAdmin
    .from("products")
    .select("*")
    .eq("id", request.params.id)
    .single();
  if (findError || !row) throw new ApiError(404, "محصول پیدا نه شو.");

  const { data: recycleRow, error: recycleError } = await supabaseAdmin
    .from("recycle_bin")
    .insert({
      entity_type: "product",
      entity_id: String(row.id),
      label: row.name || row.sku || "محصول",
      data: row,
      deleted_by: request.auth?.user?.id || null,
    })
    .select("id")
    .single();
  if (recycleError || !recycleRow) {
    throw new ApiError(400, `Recycle Bin ته انتقال ناکام شو: ${recycleError?.message || "نامعلومه ستونزه"}`);
  }

  const { data, error } = await supabaseAdmin
    .from("products")
    .update({ is_active: false })
    .eq("id", row.id)
    .select("id")
    .single();
  if (error || !data) {
    await supabaseAdmin.from("recycle_bin").delete().eq("id", recycleRow.id);
    throw new ApiError(400, error?.message || "Product delete failed");
  }

  await supabaseAdmin.from("activity_logs").insert({ user_id: request.auth.user.id, action: "product_deleted", entity_type: "product", entity_id: data.id });
  return sendData(response, { ...data, recycle_bin_id: recycleRow.id }, "Product moved to Recycle Bin");
});
