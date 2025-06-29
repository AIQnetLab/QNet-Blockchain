FROM python:3.11-slim

# Set production environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV ENVIRONMENT=production

# Create app user for security
RUN groupadd -r qnet && useradd -r -g qnet qnet

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY bridge-server.py .

# Create logs directory
RUN mkdir -p /var/log && chown -R qnet:qnet /var/log

# Change ownership to app user
RUN chown -R qnet:qnet /app

# Switch to app user
USER qnet

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/api/health || exit 1

# Expose port
EXPOSE 8080

# Start application
CMD ["python", "-m", "uvicorn", "bridge-server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "4"] 