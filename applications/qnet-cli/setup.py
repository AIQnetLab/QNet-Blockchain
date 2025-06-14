"""
Setup script for QNet CLI.
"""

from setuptools import setup, find_packages

with open("../README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="qnet-cli",
    version="0.1.0",
    author="QNet Team",
    author_email="team@qnet.network",
    description="Command line interface for QNet blockchain",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/qnet/qnet-cli",
    packages=find_packages(),
    classifiers=[
        "Programming Language :: Python :: 3",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: System :: Networking",
    ],
    python_requires=">=3.8",
    install_requires=[
        "click>=8.0.0",
        "requests>=2.25.0",
    ],
    entry_points={
        "console_scripts": [
            "qnet-cli=qnet_cli:cli",
        ],
    },
) 