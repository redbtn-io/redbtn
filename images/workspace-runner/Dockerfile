FROM node:22-bookworm-slim

# Install system dependencies: Python 3.11, git, curl, jq, tar, procps, ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    git \
    curl \
    jq \
    tar \
    procps \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Create unprivileged runner user (uid/gid 1000)
RUN groupadd -g 1000 appuser && \
    useradd -u 1000 -g appuser -m -s /bin/bash appuser

# Install @redbtn/cli globally
RUN npm install -g --production @redbtn/cli@0.0.16-alpha || npm install -g commander ws chalk

# Setup workspace directory
RUN mkdir -p /workspace /home/appuser/.config/redbtn && \
    chown -R appuser:appuser /workspace /home/appuser

# Copy entrypoint script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER appuser
WORKDIR /workspace

ENV NODE_ENV=production
ENV HOME=/home/appuser

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
