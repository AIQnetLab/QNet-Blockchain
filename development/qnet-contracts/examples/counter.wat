(module
  ;; Persistent counter for the QNet WASM VM (core/qnet-vm).
  ;;   run   — increment the counter stored under the key "count" and emit an event.
  ;;   reset — set the counter back to zero and emit an event.
  ;;
  ;; Memory layout: [0,5) storage key "count", [64,72) counter value as a
  ;; little-endian i64, [72,192) caller address bytes.

  (import "env" "storage_read"  (func $storage_read  (param i32 i32 i32 i32) (result i32)))
  (import "env" "storage_write" (func $storage_write (param i32 i32 i32 i32)))
  (import "env" "get_caller"    (func $get_caller    (param i32 i32) (result i32)))
  (import "env" "emit_log"      (func $emit_log      (param i32 i32)))

  ;; Every host pointer indexes this memory, so the export name must be exactly
  ;; "memory" and the maximum must be declared or the deploy validator rejects it.
  (memory (export "memory") 1 16)

  (data (i32.const 0) "count")

  ;; Current counter, or 0 when the key has never been written (storage_read
  ;; returns -1 for an absent key, otherwise the full stored length).
  (func $load (result i64)
    (if (i32.eq
          (call $storage_read (i32.const 0) (i32.const 5) (i32.const 64) (i32.const 8))
          (i32.const 8))
      (then (return (i64.load (i32.const 64)))))
    (i64.const 0))

  ;; Persist the new value and emit it followed by the caller address.
  (func $store_and_log (param $v i64) (local $n i32)
    (i64.store (i32.const 64) (local.get $v))
    (call $storage_write (i32.const 0) (i32.const 5) (i32.const 64) (i32.const 8))
    ;; get_caller returns the FULL address length but copies at most out_cap
    ;; bytes, so clamp before logging the region.
    (local.set $n (call $get_caller (i32.const 72) (i32.const 120)))
    (if (i32.gt_s (local.get $n) (i32.const 120))
      (then (local.set $n (i32.const 120))))
    (call $emit_log (i32.const 64) (i32.add (i32.const 8) (local.get $n))))

  ;; Entry points: the call transaction selects one by name and both must be
  ;; typed () -> () or the frame traps.
  (func (export "run")
    (call $store_and_log (i64.add (call $load) (i64.const 1))))

  (func (export "reset")
    (call $store_and_log (i64.const 0)))
)
