/*
 * EpicGamesLauncher.exe – stub minimal folosit de NexusDeck (rulează sub Wine/Proton).
 *
 * Unele jocuri de pe Epic (în special Rockstar: RDR2, GTA V) verifică faptul că au fost pornite
 * „din Epic”, adică de un proces numit EpicGamesLauncher.exe. Stub-ul pornește jocul primit ca
 * prim argument (cale Windows sau cale Unix, convertită prin Wine), îi transmite restul
 * argumentelor neschimbate și așteaptă să se închidă, întorcând codul lui de ieșire.
 *
 * Compilare: x86_64-w64-mingw32-gcc -O2 -s -municode -mwindows egl_stub.c -o EpicGamesLauncher.exe
 */
#include <windows.h>
#include <wchar.h>

typedef WCHAR *(CDECL *wine_get_dos_file_name_t)(LPCSTR);

/* Sare peste un token din linia de comandă (cu sau fără ghilimele) și peste spațiile de după. */
static const WCHAR *skip_token(const WCHAR *p, const WCHAR **tok_start, size_t *tok_len)
{
    while (*p == L' ' || *p == L'\t') p++;
    const WCHAR *start = p;
    if (*p == L'"') {
        start = ++p;
        while (*p && *p != L'"') p++;
        *tok_start = start;
        *tok_len = (size_t)(p - start);
        if (*p == L'"') p++;
    } else {
        while (*p && *p != L' ' && *p != L'\t') p++;
        *tok_start = start;
        *tok_len = (size_t)(p - start);
    }
    while (*p == L' ' || *p == L'\t') p++;
    return p;
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR pCmdLine, int nCmdShow)
{
    (void)hInst; (void)hPrev; (void)pCmdLine; (void)nCmdShow;
    const WCHAR *tok;
    size_t len;

    const WCHAR *rest = skip_token(GetCommandLineW(), &tok, &len); /* propriul nume */
    if (!*rest) return 1;

    const WCHAR *after_game = skip_token(rest, &tok, &len);         /* executabilul jocului */
    if (len == 0 || len > 32000) return 1;

    WCHAR *game = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (len + 1) * sizeof(WCHAR));
    if (!game) return 1;
    memcpy(game, tok, len * sizeof(WCHAR));

    /* Cale Unix (/home/...) -> cale DOS, prin funcția exportată de Wine */
    if (game[0] == L'/') {
        wine_get_dos_file_name_t to_dos = (wine_get_dos_file_name_t)GetProcAddress(
            GetModuleHandleW(L"kernel32.dll"), "wine_get_dos_file_name");
        if (to_dos) {
            int n = WideCharToMultiByte(CP_UTF8, 0, game, -1, NULL, 0, NULL, NULL);
            char *unix_path = (char *)HeapAlloc(GetProcessHeap(), 0, (size_t)n);
            if (unix_path && WideCharToMultiByte(CP_UTF8, 0, game, -1, unix_path, n, NULL, NULL)) {
                WCHAR *dos = to_dos(unix_path);
                if (dos) game = dos;
            }
        }
    }

    /* Folderul de lucru = folderul jocului */
    size_t glen = wcslen(game);
    WCHAR *dir = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (glen + 1) * sizeof(WCHAR));
    if (!dir) return 1;
    wcscpy(dir, game);
    WCHAR *slash = wcsrchr(dir, L'\\');
    if (slash) *slash = 0; else { HeapFree(GetProcessHeap(), 0, dir); dir = NULL; }

    /* Linia de comandă nouă: "joc" + restul argumentelor, neschimbate */
    size_t rlen = wcslen(after_game);
    size_t total = glen + rlen + 4;
    WCHAR *cmdline = (WCHAR *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, total * sizeof(WCHAR));
    if (!cmdline) return 1;
    wcscpy(cmdline, L"\"");
    wcscat(cmdline, game);
    wcscat(cmdline, L"\"");
    if (rlen) {
        wcscat(cmdline, L" ");
        wcscat(cmdline, after_game);
    }

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessW(game, cmdline, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
        return (int)GetLastError();
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}
