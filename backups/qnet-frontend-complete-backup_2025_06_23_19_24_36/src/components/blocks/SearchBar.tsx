'use client';

import type React from 'react';
import { useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { qnetAPI } from '@/lib/api';
import type { SearchResult } from '@/lib/types';

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
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);

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
        console.error('Search failed:', response.error);
      }
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);
    
    // Debounced search for better UX
    clearTimeout((window as any).searchTimeout);
    (window as any).searchTimeout = setTimeout(() => {
      handleSearch(value);
    }, 500);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      clearTimeout((window as any).searchTimeout);
      handleSearch(query);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    clearTimeout((window as any).searchTimeout);
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
                  // Handle result click navigation
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
      default:
        return '🔍';
    }
  };

  const getResultTitle = () => {
    switch (result.type) {
      case 'block':
        return `Block #${(result.data as any).index}`;
      case 'transaction':
        return `Transaction`;
      case 'address':
        return `Address`;
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