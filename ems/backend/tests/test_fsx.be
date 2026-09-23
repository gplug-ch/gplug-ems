# Tests for fsx.be — the bucket-file helpers used by store.be
# (issue #9).
#
# Run from the backend/ directory:
#   cd tests && berry -m .. test_fsx.be

import os
import fsx

# ---------------------------------------------------------------------------
# Test 1: split_prefix — device root, bare stem, absolute dir + stem
var r = fsx.split_prefix('/')
assert(r[0] == '/' && r[1] == '', f"'/' -> {r}")
r = fsx.split_prefix('tst_')
assert(r[0] == '.' && r[1] == 'tst_', f"'tst_' -> {r}")
r = fsx.split_prefix('/tmp/foo_')
assert(r[0] == '/tmp' && r[1] == 'foo_', f"'/tmp/foo_' -> {r}")
r = fsx.split_prefix('/foo_')
assert(r[0] == '/' && r[1] == 'foo_', f"'/foo_' -> {r}")
print("Test 1 passed: split_prefix")

# ---------------------------------------------------------------------------
# Test 2: dayno + sort_ints
assert(fsx.dayno(0) == 0)
assert(fsx.dayno(86399) == 0)
assert(fsx.dayno(86400) == 1)
var l = [5, 1, 4, 1, 3]
assert(fsx.sort_ints(l) == [1, 1, 3, 4, 5])
assert(l == [1, 1, 3, 4, 5], "sorts in place")
assert(fsx.sort_ints([]) == [])
print("Test 2 passed: dayno + sort_ints")

# ---------------------------------------------------------------------------
# Test 3: list_daynos — only <pat><digits> names, ascending; non-digit
# suffixes, .tmp leftovers and the bare pattern are ignored
var PAT = 'tst_fx_e15_'
def cleanup()
    for n : os.listdir('.')
        if size(n) >= 7 && n[0 .. 6] == 'tst_fx_'
            try os.remove(n) except .. end
        end
    end
end
cleanup()
for n : ['20100', '20098', '20099', '20099.tmp', 'x1', '']
    var f = open(PAT + n, 'w')
    f.close()
end
assert(fsx.list_daynos('.', PAT) == [20098, 20099, 20100], f"got {fsx.list_daynos('.', PAT)}")
assert(fsx.list_daynos('.', 'tst_fx_none_') == [])
cleanup()
print("Test 3 passed: list_daynos")

# ---------------------------------------------------------------------------
# Test 4: close_q tolerates nil and an already-closed handle
fsx.close_q(nil)
var f = open('tst_fx_c', 'w')
f.close()
fsx.close_q(f)
cleanup()
print("Test 4 passed: close_q")

print("\n--- All fsx tests passed (4 checks) ---")
