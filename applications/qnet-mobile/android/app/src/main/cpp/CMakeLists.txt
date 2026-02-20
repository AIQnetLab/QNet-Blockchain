cmake_minimum_required(VERSION 3.22.1)
project("dilithium_native" C)

# pqclean dilithium3 clean reference implementation (same as pqcrypto-dilithium 0.5)
set(DILITHIUM3_CLEAN_SRCS
    dilithium3/ntt.c
    dilithium3/packing.c
    dilithium3/poly.c
    dilithium3/polyvec.c
    dilithium3/reduce.c
    dilithium3/rounding.c
    dilithium3/sign.c
    dilithium3/symmetric-shake.c
    common/fips202.c
    randombytes_custom.c
    dilithium_jni.c
)

add_library(dilithium_native SHARED ${DILITHIUM3_CLEAN_SRCS})

target_include_directories(dilithium_native PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/dilithium3
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

