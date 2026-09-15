// Skeleton shown during server-side data fetch (client navigation)
export default function Loading() {
  return (
    <div className="explorer-page">
      <div className="explorer-header">
        <h1>Quantum Blockchain Explorer</h1>
        <p>All transactions from Genesis to Now • Block Height: ...</p>
      </div>

      <div className="explorer-search">
        <input
          type="text"
          placeholder="Search by TX hash, block number, or EON address..."
          disabled
        />
      </div>

      <div className="explorer-activity">
        <div className="activity-header">
          <h2>All Transactions</h2>
        </div>
        <div className="table-wrapper">
          <div className="table-placeholder" style={{ minHeight: '400px' }} />
        </div>
      </div>
    </div>
  );
}
