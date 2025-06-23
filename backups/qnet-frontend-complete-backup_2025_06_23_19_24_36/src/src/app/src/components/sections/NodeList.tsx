'use client';

import React from 'react';

type Node = {
  id: number;
  name: string;
  location: string;
  uptime: number;
  status: 'online' | 'offline';
};

type NodeListProps = {
  nodes: Node[];
};

const NodeList = ({ nodes }: NodeListProps) => {
  return (
    <div className="explorer-card">
      <div className="card-header">
        <h3>Active Network Nodes</h3>
      </div>
      <div className="nodes-grid">
        {nodes.map((node) => (
          <div key={node.id} className={`node-card ${node.status}`}>
            <div className="node-info">
              <div className="node-id">{node.name}</div>
              <div className="node-location">Location: {node.location}</div>
              <div className="node-uptime">Uptime: {node.uptime} days</div>
              <div>
                Status: {node.status}
                <span className={`node-status ${node.status}`}></span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default NodeList; 