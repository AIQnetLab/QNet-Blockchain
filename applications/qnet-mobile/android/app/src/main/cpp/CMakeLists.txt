cmake_minimum_required(VERSION 3.22.1)
project("dilithium_native" C)

# PQClean ml-dsa-65 clean reference (FIPS-204 final) — byte-identical to the node's
# fips204/pqcrypto-mldsa wallet keygen, so app and node derive the SAME eon per seed.
set(MLDSA65_CLEAN_SRCS
    mldsa65/ntt.c
    mldsa65/packing.c
    mldsa65/poly.c
    mldsa65/polyvec.c
    mldsa65/reduce.c
    mldsa65/rounding.c
    mldsa65/sign.c
    mldsa65/symmetric-shake.c
    common/fips202.c
    randombytes_custom.c
    dilithium_jni.c
)

add_library(dilithium_native SHARED ${MLDSA65_CLEAN_SRCS})

target_include_directories(dilithium_native PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/mldsa65
    ${CMAKE_CURRENT_SOURCE_DIR}/common
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# Suppress common PQClean warnings
target_compile_options(dilithium_native PRIVATE
    -Wall
    -Wno-unused-parameter
    -Wno-unused-variable
    -O2
)

target_link_libraries(dilithium_native
    android
    log
)

