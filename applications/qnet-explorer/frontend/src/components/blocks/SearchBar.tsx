'use client';

import type React from 'react';
import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Loader2 } from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { qnetAPI } from '@/lib/api';
import type { SearchResult } from '@/lib/types';

// Map a search result to the explorer URL it should open. Blocks/txs/addresses
// key off `hash`/`id`; token & contract results open the token detail page.
function resultHref(result: SearchResult): string {
  const key = result.id || result.hash;
  switch (result.type) {
    case 'block':
      return `/explorer/block/${key}`;
    case 'transaction':
      return `/explorer/tx/${key}`;
    case 'address':
      return `/explorer/address/${key}`;
    case 'token':
    case 'contract':
      return `/explorer/token/${key}`;
    case 'node':
      // Nodes are identified by their operator address on this explorer.
      return `/explorer/address/${key}`;
    default:
      return `/explorer/address/${key}`;
  }
}

interface SearchBarProps {
  onSearchResults?: (results: SearchResult[]) => void;
  placeholder?: string;
  className?: string;
}

export default function SearchBar({ 
  onSearchResults, 
  placeholder = "Search blocks, transactions, or addresses...",
  className = "" 
}: SearchBarProps) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  // Per-instance debounce timer so multiple SearchBars don't clobber each other.
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const response = await qnetAPI.searchBlockchain(searchQuery.trim());
      
      if (response.success && response.data) {
        setResults(response.data);
        onSearchResults?.(response.data);
      } else {
        setResults([]);
        /* log disabled */
      }
    } catch (error) {
      /* log disabled */
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    
    // Debounced search for better UX
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      handleSearch(value);
    }, 500);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      handleSearch(query);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    handleSearch(query);
  };

  return (
    <div className={`relative w-full max-w-2xl ${className}`}>
      <form onSubmit={handleSubmit} className="relative">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
          <Input
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyPress={handleKeyPress}
            placeholder={placeholder}
            className="pl-12 pr-20 h-12 quantum-card text-white placeholder-gray-400 border-purple-500/30 focus:border-purple-400 focus:quantum-glow-box"
            disabled={isSearching}
          />
          <Button
            type="submit"
            variant="quantum-primary"
            size="sm"
            className="absolute right-2 top-1/2 transform -translate-y-1/2"
            disabled={isSearching || !query.trim()}
          >
            {isSearching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              'Search'
            )}
          </Button>
        </div>
      </form>

      {/* Search Results Dropdown */}
      {results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 quantum-card border border-purple-500/30 rounded-lg overflow-hidden z-50">
          <div className="max-h-96 overflow-y-auto">
            {results.map((result, index) => (
              <SearchResultItem
                key={index}
                result={result}
                onClick={() => {
                  // Navigate to the correct explorer page for this result type,
                  // then clear the dropdown.
                  router.push(resultHref(result));
                  setResults([]);
                  setQuery('');
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* No results message */}
      {query.trim() && !isSearching && results.length === 0 && query.length > 2 && (
        <div className="absolute top-full left-0 right-0 mt-2 quantum-card border border-purple-500/30 rounded-lg p-4 text-center text-gray-400">
          No results found for "{query}"
        </div>
      )}
    </div>
  );
}

// Search Result Item Component
interface SearchResultItemProps {
  result: SearchResult;
  onClick: () => void;
}

function SearchResultItem({ result, onClick }: SearchResultItemProps) {
  const getResultIcon = () => {
    switch (result.type) {
      case 'block':
        return '📦';
      case 'transaction':
        return '💸';
      case 'address':
        return '👤';
      case 'node':
        return '🖥️';
      case 'token':
      case 'contract':
        return '🪙';
      default:
        return '🔍';
    }
  };

  const getResultTitle = () => {
    switch (result.type) {
      case 'block':
        return `Block #${(result.data as any)?.index ?? ''}`.trim();
      case 'transaction':
        return `Transaction`;
      case 'address':
        return `Address`;
      case 'node':
        return `Node`;
      case 'token':
        return result.display || 'Token';
      case 'contract':
        return result.display || 'Contract';
      default:
        return 'Result';
    }
  };

  const getResultSubtitle = () => {
    return result.hash.length > 16 
      ? `${result.hash.slice(0, 8)}...${result.hash.slice(-8)}`
      : result.hash;
  };

  return (
    <div 
      className="p-4 hover:bg-purple-500/10 cursor-pointer transition-colors border-b border-purple-500/20 last:border-b-0"
      onClick={onClick}
    >
      <div className="flex items-center space-x-3">
        <span className="text-2xl">{getResultIcon()}</span>
        <div className="flex-1 min-w-0">
          <div className="text-white font-medium">{getResultTitle()}</div>
          <div className="text-gray-400 text-sm font-mono">{getResultSubtitle()}</div>
        </div>
        <div className="text-xs text-purple-400 capitalize">
          {result.type}
        </div>
      </div>
    </div>
  );
} 
