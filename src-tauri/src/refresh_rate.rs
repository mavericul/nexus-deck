//! Rata de cadre a interfeței pe Linux.
//!
//! WebKitGTK are activat implicit `PreferPageRenderingUpdatesNear60FPS`, care ține animațiile paginii
//! la ~60 FPS indiferent de monitor. Oprindu-l, interfața urmează rata monitorului (120 / 144 Hz).
//! API-ul de „features” există doar din WebKitGTK 2.42, iar bindings-urile Rust nu-l expun: funcțiile
//! sunt căutate la rulare (dlsym), ca aplicația să pornească și pe sisteme cu WebKitGTK mai vechi.

use std::ffi::{c_char, c_int, c_void, CStr};

const FEATURE_ID: &str = "PreferPageRenderingUpdatesNear60FPS";

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// Simbol din bibliotecile deja încărcate (RTLD_DEFAULT = NULL pe glibc)
unsafe fn sym(name: &CStr) -> Option<*mut c_void> {
    let p = dlsym(std::ptr::null_mut(), name.as_ptr());
    (!p.is_null()).then_some(p)
}

type GetAllFeatures = unsafe extern "C" fn() -> *mut c_void;
type ListLength = unsafe extern "C" fn(*mut c_void) -> usize;
type ListGet = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type ListUnref = unsafe extern "C" fn(*mut c_void);
type FeatureIdentifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type SetFeatureEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int);

/// Activează (`unlimited = true`) sau dezactivează rata nativă a monitorului pentru setările unui WebView.
/// Întoarce false dacă WebKitGTK-ul instalat nu are API-ul sau flag-ul.
///
/// # Safety
/// `settings` trebuie să fie un `WebKitSettings*` valid; apelul trebuie făcut pe thread-ul GTK.
pub unsafe fn set_unlimited(settings: *mut c_void, unlimited: bool) -> bool {
    // Flag-ul *limitează* la 60 FPS: rata nativă înseamnă flag-ul oprit
    set_feature(settings, FEATURE_ID, !unlimited)
}

/// Pornește / oprește un „feature” WebKit după identificator. Întoarce false dacă nu există.
unsafe fn set_feature(settings: *mut c_void, feature_id: &str, enabled: bool) -> bool {
    let (Some(get_all), Some(len), Some(get), Some(unref), Some(ident), Some(set_enabled)) = (
        sym(c"webkit_settings_get_all_features"),
        sym(c"webkit_feature_list_get_length"),
        sym(c"webkit_feature_list_get"),
        sym(c"webkit_feature_list_unref"),
        sym(c"webkit_feature_get_identifier"),
        sym(c"webkit_settings_set_feature_enabled"),
    ) else {
        return false;
    };
    let get_all: GetAllFeatures = std::mem::transmute(get_all);
    let len: ListLength = std::mem::transmute(len);
    let get: ListGet = std::mem::transmute(get);
    let unref: ListUnref = std::mem::transmute(unref);
    let ident: FeatureIdentifier = std::mem::transmute(ident);
    let set_enabled: SetFeatureEnabled = std::mem::transmute(set_enabled);

    let list = get_all();
    if list.is_null() {
        return false;
    }
    let mut found = false;
    for i in 0..len(list) {
        let feature = get(list, i);
        let id = ident(feature);
        if !id.is_null() && CStr::from_ptr(id).to_bytes() == feature_id.as_bytes() {
            set_enabled(settings, feature, if enabled { 1 } else { 0 });
            found = true;
            break;
        }
    }
    unref(list);
    found
}
